#!/usr/bin/env php
<?php
/**
 * Cron entry point: fetch `rtk gain --all --format json` from every host in
 * rtk-hosts.json and upsert each into the rtk_* tables (keyed by host id). The
 * dashboard reads only from the DB.
 *
 *   php bin/poll-rtk.php            # all hosts
 *   php bin/poll-rtk.php vm124      # one host id
 *
 * Add to crontab (every minute, separate line from the quota poller):
 *   * * * * * php /var/www/html/glm-quota-dashboard/bin/poll-rtk.php >> /tmp/rtk-poll.log 2>&1
 *
 * Each host is fetched and stored independently: one unreachable host does not
 * block the others, and its DB rows stay untouched. Exit 0 only if every polled
 * host succeeded. See README "RTK Gain view" for rtk-hosts.json.
 */

require __DIR__ . '/../server.php';

const RTK_TIMEOUT_SECONDS = 20;

function rtkLog(string $msg): void
{
    fwrite(STDERR, '[' . date('c') . "] rtk poll: {$msg}\n");
}

/** Expand a leading "~/" in a path (config values are not shell-expanded). */
function rtkExpandPath(string $path): string
{
    if ($path !== '' && $path[0] === '~') {
        $home = getenv('HOME') ?: ($_SERVER['HOME'] ?? '');
        return $home . substr($path, 1);
    }
    return $path;
}

/**
 * Run a command without a shell (argv list, no interpolation) with a wall-clock
 * timeout. Returns [exitCode, stdout, stderr]; exitCode -1 on timeout/start failure.
 */
function rtkRun(array $argv, int $timeout): array
{
    $desc = [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $proc = proc_open($argv, $desc, $pipes);
    if (!is_resource($proc)) {
        return [-1, '', 'could not start command'];
    }

    $open = [1 => $pipes[1], 2 => $pipes[2]];
    $buf = [1 => '', 2 => ''];
    $deadline = microtime(true) + $timeout;

    while ($open) {
        $left = $deadline - microtime(true);
        if ($left <= 0) {
            break;
        }
        $read = array_values($open);
        $write = $except = null;
        if (@stream_select($read, $write, $except, 0, (int)($left * 1_000_000)) === false) {
            break;
        }
        foreach ($read as $stream) {
            $fd = array_search($stream, $open, true);
            $chunk = fread($stream, 8192);
            if ($chunk !== false && $chunk !== '') {
                $buf[$fd] .= $chunk;
            }
            if (feof($stream)) {
                fclose($stream);
                unset($open[$fd]);
            }
        }
    }

    $timedOut = (bool)$open;
    if ($timedOut) {
        foreach ($open as $stream) {
            fclose($stream);
        }
        proc_terminate($proc, 9);
    }
    $code = proc_close($proc);

    return [$timedOut ? -1 : $code, $buf[1], $buf[2] . ($timedOut ? "\ntimed out after {$timeout}s" : '')];
}

/** Non-negative integer from an untrusted value; anything odd becomes 0. */
function rtkInt(mixed $v): int
{
    return is_numeric($v) ? max(0, (int)$v) : 0;
}

/** Percentage clamped to the DECIMAL(5,2) range the tables use. */
function rtkPct(mixed $v): float
{
    return is_numeric($v) ? round(max(0.0, min(100.0, (float)$v)), 2) : 0.0;
}

function rtkDateOrNull(mixed $v): ?string
{
    return is_string($v) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) ? $v : null;
}

/** Fetch rtk's JSON for one host. Throws RuntimeException on any failure. */
function rtkFetch(array $h): string
{
    if ($h['source'] === 'local') {
        // Split on whitespace (no shell): first token is the binary.
        $argv = preg_split('/\s+/', trim($h['command'])) ?: [];
        if ($argv === []) {
            throw new RuntimeException('command is empty');
        }
        $argv[0] = rtkExpandPath($argv[0]);
    } else {
        if ($h['ssh_host'] === '') {
            throw new RuntimeException('ssh_host is not set');
        }
        $key = rtkExpandPath($h['ssh_key']);
        $argv = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'];
        if ($key !== '') {
            array_push($argv, '-i', $key);
        }
        $target = $h['ssh_user'] !== '' ? "{$h['ssh_user']}@{$h['ssh_host']}" : $h['ssh_host'];
        array_push($argv, $target, $h['command']);
    }

    [$code, $stdout, $stderr] = rtkRun($argv, RTK_TIMEOUT_SECONDS);
    if ($code !== 0) {
        throw new RuntimeException('exit ' . $code . ($stderr !== '' ? ': ' . trim($stderr) : ''));
    }
    if (trim($stdout) === '') {
        throw new RuntimeException('empty output from rtk');
    }
    return $stdout;
}

/**
 * Validate rtk's JSON and upsert it under $host. Last-write-wins per bucket.
 * Throws on validation or DB failure, leaving the host's rows untouched.
 * @return array{daily:int,weekly:int,monthly:int}
 */
function rtkStore(string $host, string $stdout): array
{
    $data = json_decode($stdout, true);
    if (!is_array($data) || !is_array($data['summary'] ?? null) || !is_array($data['daily'] ?? null)) {
        throw new RuntimeException('output is not the expected rtk gain JSON (missing summary/daily)');
    }
    $summary = $data['summary'];
    $skipped = 0;

    $daily = [];
    foreach ($data['daily'] as $row) {
        $date = is_array($row) ? rtkDateOrNull($row['date'] ?? null) : null;
        if ($date === null) {
            $skipped++;
            continue;
        }
        $daily[] = [$date, rtkInt($row['commands'] ?? 0), rtkInt($row['input_tokens'] ?? 0),
            rtkInt($row['output_tokens'] ?? 0), rtkInt($row['saved_tokens'] ?? 0), rtkPct($row['savings_pct'] ?? 0)];
    }

    $weekly = [];
    foreach (is_array($data['weekly'] ?? null) ? $data['weekly'] : [] as $row) {
        $start = is_array($row) ? rtkDateOrNull($row['week_start'] ?? null) : null;
        if ($start === null) {
            $skipped++;
            continue;
        }
        $weekly[] = [$start, rtkDateOrNull($row['week_end'] ?? null), rtkInt($row['commands'] ?? 0),
            rtkInt($row['input_tokens'] ?? 0), rtkInt($row['output_tokens'] ?? 0),
            rtkInt($row['saved_tokens'] ?? 0), rtkPct($row['savings_pct'] ?? 0)];
    }

    $monthly = [];
    foreach (is_array($data['monthly'] ?? null) ? $data['monthly'] : [] as $row) {
        $month = is_array($row) && is_string($row['month'] ?? null) && preg_match('/^\d{4}-\d{2}$/', $row['month'])
            ? $row['month'] : null;
        if ($month === null) {
            $skipped++;
            continue;
        }
        $monthly[] = [$month, rtkInt($row['commands'] ?? 0), rtkInt($row['input_tokens'] ?? 0),
            rtkInt($row['output_tokens'] ?? 0), rtkInt($row['saved_tokens'] ?? 0), rtkPct($row['savings_pct'] ?? 0)];
    }

    if ($skipped > 0) {
        rtkLog("[{$host}] skipped {$skipped} malformed bucket(s)");
    }

    $now = date('Y-m-d H:i:s');
    $pdo = db();
    try {
        $pdo->beginTransaction();

        $pdo->prepare(
            'INSERT INTO rtk_summary (host, total_commands, total_input, total_output, total_saved, avg_savings_pct, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               total_commands = VALUES(total_commands), total_input = VALUES(total_input),
               total_output = VALUES(total_output), total_saved = VALUES(total_saved),
               avg_savings_pct = VALUES(avg_savings_pct), fetched_at = VALUES(fetched_at)'
        )->execute([
            $host,
            rtkInt($summary['total_commands'] ?? 0), rtkInt($summary['total_input'] ?? 0),
            rtkInt($summary['total_output'] ?? 0), rtkInt($summary['total_saved'] ?? 0),
            rtkPct($summary['avg_savings_pct'] ?? 0), $now,
        ]);

        $stmt = $pdo->prepare(
            'INSERT INTO rtk_daily (host, log_date, commands, input_tokens, output_tokens, saved_tokens, savings_pct, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               commands = VALUES(commands), input_tokens = VALUES(input_tokens),
               output_tokens = VALUES(output_tokens), saved_tokens = VALUES(saved_tokens),
               savings_pct = VALUES(savings_pct), updated_at = VALUES(updated_at)'
        );
        foreach ($daily as $r) {
            $stmt->execute([$host, ...$r, $now]);
        }

        $stmt = $pdo->prepare(
            'INSERT INTO rtk_weekly (host, week_start, week_end, commands, input_tokens, output_tokens, saved_tokens, savings_pct, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               week_end = VALUES(week_end), commands = VALUES(commands), input_tokens = VALUES(input_tokens),
               output_tokens = VALUES(output_tokens), saved_tokens = VALUES(saved_tokens),
               savings_pct = VALUES(savings_pct), updated_at = VALUES(updated_at)'
        );
        foreach ($weekly as $r) {
            $stmt->execute([$host, ...$r, $now]);
        }

        $stmt = $pdo->prepare(
            'INSERT INTO rtk_monthly (host, log_month, commands, input_tokens, output_tokens, saved_tokens, savings_pct, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               commands = VALUES(commands), input_tokens = VALUES(input_tokens),
               output_tokens = VALUES(output_tokens), saved_tokens = VALUES(saved_tokens),
               savings_pct = VALUES(savings_pct), updated_at = VALUES(updated_at)'
        );
        foreach ($monthly as $r) {
            $stmt->execute([$host, ...$r, $now]);
        }

        // Upsert, not REPLACE: the app DB user has INSERT/UPDATE but no DELETE.
        $pdo->prepare(
            'INSERT INTO rtk_raw (host, payload, fetched_at) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE payload = VALUES(payload), fetched_at = VALUES(fetched_at)'
        )->execute([$host, $stdout, $now]);

        $pdo->commit();
    } catch (Throwable $t) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw new RuntimeException('db write failed: ' . $t->getMessage(), 0, $t);
    }

    return ['daily' => count($daily), 'weekly' => count($weekly), 'monthly' => count($monthly)];
}

/** Fetch + store one host. Logs and returns false on failure; never throws. */
function rtkPollHost(array $h): bool
{
    try {
        $counts = rtkStore($h['id'], rtkFetch($h));
    } catch (Throwable $t) {
        rtkLog("[{$h['id']}] failed: " . $t->getMessage());
        return false;
    }
    fwrite(STDOUT, '[' . date('c') . "] rtk poll ok [{$h['id']}]: {$counts['daily']} daily, "
        . "{$counts['weekly']} weekly, {$counts['monthly']} monthly\n");
    return true;
}

/* ---------------------------------- main ---------------------------------- */

try {
    $hosts = rtkHosts();
} catch (RuntimeException $t) {
    rtkLog('config: ' . $t->getMessage());
    exit(1);
}

$only = $_SERVER['argv'][1] ?? null;
$ran = 0;
$failed = 0;
foreach ($hosts as $h) {
    if ($only !== null && $h['id'] !== $only) {
        continue;
    }
    $ran++;
    if (!rtkPollHost($h)) {
        $failed++;
    }
}
if ($ran === 0) {
    rtkLog("no configured host matches '{$only}'");
    exit(1);
}
exit($failed > 0 ? 1 : 0);
