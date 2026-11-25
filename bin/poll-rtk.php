#!/usr/bin/env php
<?php
/**
 * Cron entry point: pull `rtk gain --all --format json` from vm124 over SSH and
 * upsert it into the rtk_* tables. The dashboard reads only from the DB.
 *
 * Add to crontab (every minute, separate line from the quota poller):
 *   * * * * * php /var/www/html/glm-quota-dashboard/bin/poll-rtk.php >> /tmp/rtk-poll.log 2>&1
 *
 * Config (.env or process env): RTK_SSH_HOST, RTK_SSH_USER, RTK_SSH_KEY (optional
 * private-key path, `~` expanded), RTK_REMOTE_CMD. See README "RTK Gain view".
 *
 * On any failure the DB is left untouched; staleness shows via fetched_at age.
 */

require __DIR__ . '/../server.php';

const RTK_TIMEOUT_SECONDS = 20;
const RTK_DEFAULT_CMD = '/home/armand/.local/bin/rtk gain --all --format json';

function rtkLog(string $msg): void
{
    fwrite(STDERR, '[' . date('c') . "] rtk poll: {$msg}\n");
}

function rtkFail(string $msg): never
{
    rtkLog("failed: {$msg}");
    exit(1);
}

/** Expand a leading "~/" (.env values are not shell-expanded). */
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
        return [-1, '', 'could not start ssh'];
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

/* --------------------------------- fetch ---------------------------------- */

$e = env();
$host = $e['RTK_SSH_HOST'] ?? '192.168.10.124';
$user = $e['RTK_SSH_USER'] ?? 'armand';
$key = rtkExpandPath($e['RTK_SSH_KEY'] ?? '');
$remoteCmd = ($e['RTK_REMOTE_CMD'] ?? '') !== '' ? $e['RTK_REMOTE_CMD'] : RTK_DEFAULT_CMD;

$argv = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'];
if ($key !== '') {
    array_push($argv, '-i', $key);
}
array_push($argv, "{$user}@{$host}", $remoteCmd);

[$code, $stdout, $stderr] = rtkRun($argv, RTK_TIMEOUT_SECONDS);
if ($code !== 0) {
    rtkFail('ssh/rtk exit ' . $code . ($stderr !== '' ? ': ' . trim($stderr) : ''));
}
if (trim($stdout) === '') {
    rtkFail('empty output from rtk');
}

/* ------------------------------- validate --------------------------------- */

$data = json_decode($stdout, true);
if (!is_array($data) || !is_array($data['summary'] ?? null) || !is_array($data['daily'] ?? null)) {
    rtkFail('output is not the expected rtk gain JSON (missing summary/daily)');
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
    rtkLog("skipped {$skipped} malformed bucket(s)");
}

/* -------------------------------- upsert ---------------------------------- */

$now = date('Y-m-d H:i:s');
$pdo = db();

try {
    $pdo->beginTransaction();

    $pdo->prepare(
        'INSERT INTO rtk_summary (id, total_commands, total_input, total_output, total_saved, avg_savings_pct, fetched_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           total_commands = VALUES(total_commands), total_input = VALUES(total_input),
           total_output = VALUES(total_output), total_saved = VALUES(total_saved),
           avg_savings_pct = VALUES(avg_savings_pct), fetched_at = VALUES(fetched_at)'
    )->execute([
        rtkInt($summary['total_commands'] ?? 0), rtkInt($summary['total_input'] ?? 0),
        rtkInt($summary['total_output'] ?? 0), rtkInt($summary['total_saved'] ?? 0),
        rtkPct($summary['avg_savings_pct'] ?? 0), $now,
    ]);

    $stmt = $pdo->prepare(
        'INSERT INTO rtk_daily (log_date, commands, input_tokens, output_tokens, saved_tokens, savings_pct, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           commands = VALUES(commands), input_tokens = VALUES(input_tokens),
           output_tokens = VALUES(output_tokens), saved_tokens = VALUES(saved_tokens),
           savings_pct = VALUES(savings_pct), updated_at = VALUES(updated_at)'
    );
    foreach ($daily as $r) {
        $stmt->execute([...$r, $now]);
    }

    $stmt = $pdo->prepare(
        'INSERT INTO rtk_weekly (week_start, week_end, commands, input_tokens, output_tokens, saved_tokens, savings_pct, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           week_end = VALUES(week_end), commands = VALUES(commands), input_tokens = VALUES(input_tokens),
           output_tokens = VALUES(output_tokens), saved_tokens = VALUES(saved_tokens),
           savings_pct = VALUES(savings_pct), updated_at = VALUES(updated_at)'
    );
    foreach ($weekly as $r) {
        $stmt->execute([...$r, $now]);
    }

    $stmt = $pdo->prepare(
        'INSERT INTO rtk_monthly (log_month, commands, input_tokens, output_tokens, saved_tokens, savings_pct, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           commands = VALUES(commands), input_tokens = VALUES(input_tokens),
           output_tokens = VALUES(output_tokens), saved_tokens = VALUES(saved_tokens),
           savings_pct = VALUES(savings_pct), updated_at = VALUES(updated_at)'
    );
    foreach ($monthly as $r) {
        $stmt->execute([...$r, $now]);
    }

    // Upsert, not REPLACE: the app DB user has INSERT/UPDATE but no DELETE.
    $pdo->prepare(
        'INSERT INTO rtk_raw (id, payload, fetched_at) VALUES (1, ?, ?)
         ON DUPLICATE KEY UPDATE payload = VALUES(payload), fetched_at = VALUES(fetched_at)'
    )->execute([$stdout, $now]);

    $pdo->commit();
} catch (Throwable $t) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    rtkFail('db write failed: ' . $t->getMessage());
}

fwrite(STDOUT, '[' . date('c') . '] rtk poll ok: ' . count($daily) . ' daily, '
    . count($weekly) . ' weekly, ' . count($monthly) . " monthly\n");
exit(0);
