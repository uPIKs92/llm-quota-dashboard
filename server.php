<?php
$env = parse_ini_file(__DIR__ . '/.env');
$key = $env['GLM_API_KEY'] ?? getenv('GLM_API_KEY');

$path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);

if ($path === '/api/stats') {
    if (!$key) { http_response_code(500); exit('GLM_API_KEY not set'); }
    $ch = curl_init('https://glm.ajianaz.dev/stats');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $key],
        CURLOPT_TIMEOUT => 15,
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($code === 200 && $body) {
        $data = json_decode($body, true);
        if (is_array($data)) {
            logDaily((int)($data['total_lifetime_tokens'] ?? 0), (int)($data['total_requests'] ?? 0));
            maybeAlertReset($data['current_usage']['window_ends_at'] ?? '');
            maybeAlertResetNow($data['current_usage']['window_started_at'] ?? '');
            maybeAlertUsage($data);
        }
    }

    http_response_code($code ?: 500);
    header('Content-Type: application/json');
    exit($body ?: '{"error":"upstream failed"}');
}

if ($path === '/api/history') {
    header('Content-Type: application/json');
    exit(json_encode(history()));
}

header('Content-Type: text/html; charset=utf-8');
readfile(__DIR__ . '/index.html');

function logDaily(int $lifetimeTokens, int $requests): void
{
    $pdo = db();
    $today = date('Y-m-d');
    $stmt = $pdo->prepare('SELECT lifetime_tokens FROM token_daily_log WHERE log_date = ?');
    $stmt->execute([$today]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($row) {
        // anchor never moves; delta = current lifetime - day start anchor
        $delta = max($lifetimeTokens - (int)$row['lifetime_tokens'], 0);
        $upd = $pdo->prepare('UPDATE token_daily_log SET tokens_used = ?, requests = ? WHERE log_date = ?');
        $upd->execute([$delta, $requests, $today]);
    } else {
        // baseline = previous day's final lifetime
        $prev = $pdo->prepare('SELECT lifetime_tokens FROM token_daily_log WHERE log_date < ? ORDER BY log_date DESC LIMIT 1');
        $prev->execute([$today]);
        $base = (int)$prev->fetchColumn();
        $ins = $pdo->prepare('INSERT INTO token_daily_log (log_date, tokens_used, requests, lifetime_tokens) VALUES (?, ?, ?, ?)');
        $ins->execute([$today, max($lifetimeTokens - $base, 0), $requests, $base]);
    }
}

function history(int $days = 14): array
{
    $pdo = db();
    $stmt = $pdo->prepare('SELECT log_date, tokens_used, requests FROM token_daily_log WHERE log_date >= ? ORDER BY log_date ASC');
    $stmt->execute([date('Y-m-d', strtotime("-" . ($days - 1) . " days"))]);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function maybeAlertResetNow(string $windowStartedAt): void
{
    $env = parse_ini_file(__DIR__ . '/.env');
    $bot = $env['TELEGRAM_BOT_TOKEN'] ?? '';
    $chat = $env['TELEGRAM_CHAT_ID'] ?? '';
    if (!$bot || !$chat || !$windowStartedAt) return;

    $pdo = db();
    $stmt = $pdo->query('SELECT last_window_started_at FROM alert_state WHERE id = 1');
    $last = $stmt->fetchColumn();
    if ($last === $windowStartedAt) return; // same window, nothing new

    // first ever poll (column NULL) — baseline, don't alert
    if ($last === null || $last === false) {
        $upd = $pdo->prepare('UPDATE alert_state SET last_window_started_at = ? WHERE id = 1');
        $upd->execute([$windowStartedAt]);
        return;
    }

    $start = strtotime($windowStartedAt);
    $lastTs = strtotime($last);
    if ($start === false || $lastTs === false) return;

    $elapsedMin = (int)((time() - $start) / 60);
    $text = "✅ *Quota GLM sudah reset*\\n"
        . "Window baru dimulai: " . date('H:i', $start) . " WIB\\n"
        . "Terdeteksi " . $elapsedMin . " menit setelah reset";

    if (tgSend($text)) {
        $upd = $pdo->prepare('UPDATE alert_state SET last_window_started_at = ? WHERE id = 1');
        $upd->execute([$windowStartedAt]);
    }
}

/**
 * Alert via Telegram when the quota window is about to reset.
 * Sends once per window (dedup key = window_ends_at timestamp).
 */
function maybeAlertReset(string $windowEndsAt): void
{
    $env = parse_ini_file(__DIR__ . '/.env');
    $bot = $env['TELEGRAM_BOT_TOKEN'] ?? '';
    $chat = $env['TELEGRAM_CHAT_ID'] ?? '';
    if (!$bot || !$chat) return; // not configured yet

    $windowEnd = strtotime($windowEndsAt);
    if (!$windowEnd) return;
    $remainingMin = (int)round(($windowEnd - time()) / 60);
    $thresholdMin = (int)($env['ALERT_WINDOW_MINUTES'] ?? 30);
    if ($remainingMin > $thresholdMin) return;

    $pdo = db();
    $stmt = $pdo->query('SELECT last_alerted_window_end FROM alert_state WHERE id = 1');
    if ($stmt->fetchColumn() === $windowEndsAt) return; // already alerted this window

    $text = "⚠️ *Quota GLM reset sebentar lagi*\n"
        . "Sisa waktu: {$remainingMin} menit\n"
        . "Reset: " . (new DateTime('@' . $windowEnd))->setTimezone(new DateTimeZone('Asia/Jakarta'))->format('H:i') . " WIB";

    if (tgSend($text)) {
        $upd = $pdo->prepare('UPDATE alert_state SET last_alerted_window_end = ? WHERE id = 1');
        $upd->execute([$windowEndsAt]);
    }
}

/**
 * Alert via Telegram when token usage crosses a milestone (25/50/75/90%).
 * Sends once per milestone per window (dedup key = milestone + window start).
 */
function maybeAlertUsage(array $data): void
{
    $env = parse_ini_file(__DIR__ . '/.env');
    if (empty($env['TELEGRAM_BOT_TOKEN']) || empty($env['TELEGRAM_CHAT_ID'])) return;

    $used = (int)($data['current_usage']['tokens_used_in_current_window'] ?? 0);
    $limit = (int)($data['token_limit_per_5h'] ?? 0);
    $windowStart = $data['current_usage']['window_started_at'] ?? '';
    if ($limit <= 0 || !$windowStart) return;

    $pct = $used / $limit * 100;
    $milestones = [25, 50, 75, 90];
    $hit = null;
    foreach ($milestones as $m) {
        if ($pct >= $m) $hit = $m;
    }
    if ($hit === null) return;

    $pdo = db();
    $stmt = $pdo->prepare('SELECT usage_window, alerted_milestones FROM alert_state WHERE id = 1');
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    $done = ($row['usage_window'] === $windowStart)
        ? explode(',', $row['alerted_milestones'] ?? '')
        : [];
    if (in_array((string)$hit, $done, true)) return; // already alerted this milestone

    $text = "📊 *Pemakaian token {$hit}%*\n"
        . "Terpakai: " . number_format($used, 0, ',', '.') . " / "
        . number_format($limit, 0, ',', '.') . " token\n"
        . "Sisa: " . number_format($limit - $used, 0, ',', '.') . " token";

    if (tgSend($text)) {
        $done[] = (string)$hit;
        $upd = $pdo->prepare(
            'UPDATE alert_state SET usage_window = ?, alerted_milestones = ? WHERE id = 1'
        );
        $upd->execute([$windowStart, implode(',', $done)]);
    }
}

/** Send a Telegram message. Returns true on HTTP 200. */
function tgSend(string $text): bool
{
    $env = parse_ini_file(__DIR__ . '/.env');
    $bot = $env['TELEGRAM_BOT_TOKEN'] ?? '';
    $chat = $env['TELEGRAM_CHAT_ID'] ?? '';
    if (!$bot || !$chat) return false;

    $ch = curl_init('https://api.telegram.org/bot' . $bot . '/sendMessage');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => http_build_query([
            'chat_id' => $chat,
            'text' => $text,
            'parse_mode' => 'Markdown',
        ]),
        CURLOPT_TIMEOUT => 10,
    ]);
    $ok = curl_exec($ch);
    $http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return (bool)$ok && $http === 200;
}

function db(): PDO
{
    $env = parse_ini_file(__DIR__ . '/.env');
    $dsn = 'mysql:host=' . ($env['DB_HOST'] ?? '127.0.0.1')
        . ';dbname=' . ($env['DB_DATABASE'] ?? 'quota_dash') . ';charset=utf8mb4';
    return new PDO($dsn, $env['DB_USERNAME'] ?? 'quota_user', $env['DB_PASSWORD'] ?? '', [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    ]);
}
