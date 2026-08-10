<?php
/**
 * LLM Quota Dashboard — backend.
 *
 * Single entry point: proxies a configurable upstream quota API, logs daily
 * stats, fires Telegram alerts, handles bot commands, and serves the SPA.
 *
 * Generic — works with any upstream returning JSON. Response fields are mapped
 * to a canonical shape via FIELD_* env vars (defaults match the original proxy
 * contract, so existing setups work with zero config).
 */

$env = env();
$path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH);

if ($path === '/api/stats') {
    $result = pollQuota();
    http_response_code($result['code'] ?: 500);
    header('Content-Type: application/json');
    exit($result['body'] ?: '{"error":"upstream failed"}');
}

if ($path === '/api/history') {
    header('Content-Type: application/json');
    exit(json_encode(history()));
}

if ($path === '/api/config') {
    header('Content-Type: application/json');
    exit(json_encode(['appName' => appName()]));
}

if ($path === '/api/tg/webhook') {
    header('Content-Type: text/plain');
    // Verify Telegram secret token if configured (defense in depth).
    $expected = $env['TELEGRAM_WEBHOOK_SECRET'] ?? '';
    if ($expected !== '') {
        $got = $_SERVER['HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN'] ?? '';
        if (!hash_equals($expected, $got)) {
            http_response_code(401);
            exit('unauthorized');
        }
    }
    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input || empty($input['message'])) {
        exit('no message');
    }
    handleTgCommand($input);
    exit('ok');
}

// Serve the SPA for browser requests; skip when included by CLI scripts.
if (php_sapi_name() !== 'cli') {
    header('Content-Type: text/html; charset=utf-8');
    readfile(__DIR__ . '/index.html');
}

/* ----------------------------- config helpers ----------------------------- */

/** Parse and cache .env once per request/process. */
function env(): array
{
    static $cache = null;
    if ($cache === null) {
        $cache = parse_ini_file(__DIR__ . '/.env') ?: [];
    }
    return $cache;
}

function appName(): string
{
    return env()['APP_NAME'] ?? 'LLM Quota';
}

function tz(): DateTimeZone
{
    return new DateTimeZone(env()['TZ'] ?? 'Asia/Jakarta');
}

/** Short timezone abbreviation (e.g. WIB, UTC, EST) for display. */
function tzAbbr(): string
{
    return (new DateTime('now', tz()))->format('T');
}

function upstreamUrl(): string
{
    return rtrim(env()['UPSTREAM_URL'] ?? '', '/');
}

/** API key with back-compat fallback to the legacy GLM_API_KEY name. */
function apiKey(): string
{
    $e = env();
    if (!empty($e['API_KEY'])) return $e['API_KEY'];
    if (!empty($e['GLM_API_KEY'])) return $e['GLM_API_KEY'];
    $g = getenv('API_KEY');
    return $g ?: '';
}

/* --------------------------- response normalizer -------------------------- */

/**
 * Resolve a dotted path inside a nested array; returns $default if missing.
 * e.g. get($data, 'current_usage.tokens_used_in_current_window')
 */
function get(array $data, string $path, mixed $default = null): mixed
{
    $cur = $data;
    foreach (explode('.', $path) as $seg) {
        if (!is_array($cur) || !array_key_exists($seg, $cur)) {
            return $default;
        }
        $cur = $cur[$seg];
    }
    return $cur;
}

/**
 * Map an upstream JSON response to the canonical shape used by the frontend,
 * alerts, logging, and bot replies. Paths configurable via FIELD_* env vars.
 *
 * @return array{name:string,model:string,limit:int,used:int,remaining:int,windowStart:string,windowEnd:string,totalRequests:int,totalLifetime:int,isExpired:bool,expiryDate:string,lastUsed:string}
 */
function normalizeQuota(array $raw): array
{
    $e = env();
    return [
        'name'          => (string)get($raw, $e['FIELD_NAME'] ?? 'name', ''),
        'model'         => (string)get($raw, $e['FIELD_MODEL'] ?? 'model', ''),
        'limit'         => (int)get($raw, $e['FIELD_LIMIT'] ?? 'token_limit_per_5h', 0),
        'used'          => (int)get($raw, $e['FIELD_USED'] ?? 'current_usage.tokens_used_in_current_window', 0),
        'remaining'     => (int)get($raw, $e['FIELD_REMAINING'] ?? 'current_usage.remaining_tokens', 0),
        'windowStart'   => (string)get($raw, $e['FIELD_WINDOW_START'] ?? 'current_usage.window_started_at', ''),
        'windowEnd'     => (string)get($raw, $e['FIELD_WINDOW_END'] ?? 'current_usage.window_ends_at', ''),
        'totalRequests' => (int)get($raw, $e['FIELD_TOTAL_REQUESTS'] ?? 'total_requests', 0),
        'totalLifetime' => (int)get($raw, $e['FIELD_TOTAL_LIFETIME'] ?? 'total_lifetime_tokens', 0),
        'isExpired'     => (bool)get($raw, $e['FIELD_IS_EXPIRED'] ?? 'is_expired', false),
        'expiryDate'    => (string)get($raw, $e['FIELD_EXPIRY_DATE'] ?? 'expiry_date', ''),
        'lastUsed'      => (string)get($raw, $e['FIELD_LAST_USED'] ?? 'last_used', ''),
    ];
}

/** Fetch upstream quota and normalize. Returns null on any failure. */
function fetchUpstream(): ?array
{
    $url = upstreamUrl();
    if (!$url) return null;
    $key = apiKey();
    $ch = curl_init($url);
    $headers = ['Accept: application/json'];
    if ($key) $headers[] = 'Authorization: Bearer ' . $key;
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_TIMEOUT => 15,
    ]);
    $body = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($code !== 200 || !$body) return null;
    $data = json_decode($body, true);
    return is_array($data) ? normalizeQuota($data) : null;
}

/* -------------------------------- polling --------------------------------- */

/**
 * Fetch quota from upstream, log daily stats, fire alerts, and return the
 * normalized payload. Called by /api/stats and bin/poll.php (cron).
 *
 * @return array{code:int, body:string}
 */
function pollQuota(): array
{
    if (!upstreamUrl()) {
        return ['code' => 500, 'body' => '{"error":"UPSTREAM_URL not set"}'];
    }
    if (!apiKey()) {
        return ['code' => 500, 'body' => '{"error":"API_KEY not set"}'];
    }

    $ch = curl_init(upstreamUrl());
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ['Accept: application/json', 'Authorization: Bearer ' . apiKey()],
        CURLOPT_TIMEOUT => 15,
    ]);
    $body = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($code === 200 && $body) {
        $data = json_decode($body, true);
        if (is_array($data)) {
            $q = normalizeQuota($data);
            logDaily($q['totalLifetime'], $q['totalRequests']);
            maybeAlertReset($q['windowEnd']);
            maybeAlertResetNow($q['windowStart']);
            maybeAlertUsage($q);
            $body = json_encode($q);
        }
    }

    return ['code' => $code, 'body' => $body ?: ''];
}

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
        // first poll of the day: anchor = current lifetime, delta starts at 0
        $ins = $pdo->prepare('INSERT INTO token_daily_log (log_date, tokens_used, requests, lifetime_tokens) VALUES (?, ?, ?, ?)');
        $ins->execute([$today, 0, $requests, $lifetimeTokens]);
    }
}

function history(int $days = 14): array
{
    $pdo = db();
    $stmt = $pdo->prepare('SELECT log_date, tokens_used, requests FROM token_daily_log WHERE log_date >= ? ORDER BY log_date ASC');
    $stmt->execute([date('Y-m-d', strtotime("-" . ($days - 1) . " days"))]);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

/* --------------------------------- alerts --------------------------------- */

/** Alert once when a new quota window is detected (reset happened). */
function maybeAlertResetNow(string $windowStartedAt): void
{
    $e = env();
    $bot = $e['TELEGRAM_BOT_TOKEN'] ?? '';
    $chat = $e['TELEGRAM_CHAT_ID'] ?? '';
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
    if ($start <= $lastTs) return; // not a newer window than what we already logged

    $startFmt = (new DateTime('@' . $start))->setTimezone(tz())->format('H:i');
    $elapsedMin = (int)max((time() - $start) / 60, 0);
    $text = "✅ *" . appName() . " quota reset*\n"
        . "New window started: {$startFmt} " . tzAbbr() . "\n"
        . "Detected {$elapsedMin} min after reset";

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
    $e = env();
    $bot = $e['TELEGRAM_BOT_TOKEN'] ?? '';
    $chat = $e['TELEGRAM_CHAT_ID'] ?? '';
    if (!$bot || !$chat) return; // not configured yet

    $windowEnd = strtotime($windowEndsAt);
    if (!$windowEnd) return;
    $remainingMin = (int)round(($windowEnd - time()) / 60);
    $thresholdMin = (int)($e['ALERT_WINDOW_MINUTES'] ?? 30);
    if ($remainingMin > $thresholdMin) return;

    $pdo = db();
    $stmt = $pdo->query('SELECT last_alerted_window_end FROM alert_state WHERE id = 1');
    if ($stmt->fetchColumn() === $windowEndsAt) return; // already alerted this window

    $resetFmt = (new DateTime('@' . $windowEnd))->setTimezone(tz())->format('H:i');
    $text = "⚠️ *" . appName() . " quota reset soon*\n"
        . "Time left: {$remainingMin} min\n"
        . "Reset: {$resetFmt} " . tzAbbr() . "\n";

    if (tgSend($text)) {
        $upd = $pdo->prepare('UPDATE alert_state SET last_alerted_window_end = ? WHERE id = 1');
        $upd->execute([$windowEndsAt]);
    }
}

/**
 * Alert via Telegram when token usage crosses a milestone (25/50/75/90%).
 * Sends once per milestone per window (dedup key = milestone + window start).
 */
function maybeAlertUsage(array $q): void
{
    $e = env();
    if (empty($e['TELEGRAM_BOT_TOKEN']) || empty($e['TELEGRAM_CHAT_ID'])) return;

    $used = $q['used'];
    $limit = $q['limit'];
    $windowStart = $q['windowStart'];
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

    $text = "📊 *Token usage {$hit}%*\n"
        . "Used: " . number_format($used) . " / " . number_format($limit) . "\n"
        . "Remaining: " . number_format($limit - $used);

    if (tgSend($text)) {
        $done[] = (string)$hit;
        $upd = $pdo->prepare(
            'UPDATE alert_state SET usage_window = ?, alerted_milestones = ? WHERE id = 1'
        );
        $upd->execute([$windowStart, implode(',', $done)]);
    }
}

/* ----------------------------- telegram bot ------------------------------ */

/**
 * Handle incoming Telegram bot commands. Commands derive from BOT_COMMAND_PREFIX:
 *   prefix=""  -> /quota /reset /help
 *   prefix="x" -> /xquota /x /xreset /xhelp
 */
function handleTgCommand(array $update): void
{
    $e = env();
    $bot = $e['TELEGRAM_BOT_TOKEN'] ?? '';
    $authChat = $e['TELEGRAM_CHAT_ID'] ?? '';
    if (!$bot || !$authChat) return;

    $msg = $update['message'];
    $chatId = (string)($msg['chat']['id'] ?? '');
    $text = trim($msg['text'] ?? '');
    $msgId = (int)($msg['message_id'] ?? 0);

    if ($chatId !== $authChat) return; // authorized chat only

    $prefix = strtolower(trim($e['BOT_COMMAND_PREFIX'] ?? ''));
    $cmdQuota = '/' . $prefix . 'quota';
    $cmdReset = '/' . $prefix . 'reset';
    $cmdHelp  = '/' . $prefix . 'help';
    $cmdShort = $prefix ? '/' . $prefix : '/quota';

    $cmd = explode(' ', $text)[0];
    $cmd = strtolower(preg_replace('/@.*$/', '', $cmd));

    switch ($cmd) {
        case $cmdQuota:
        case $cmdShort:
            sendQuotaReply($bot, $chatId, $msgId);
            break;
        case $cmdReset:
            sendResetReply($bot, $chatId, $msgId);
            break;
        case $cmdHelp:
            tgReply($bot, $chatId, $msgId,
                "🤖 *" . appName() . " Bot Commands*\n\n"
                . "{$cmdQuota}, {$cmdShort} — Check quota usage\n"
                . "{$cmdReset} — Check reset countdown\n"
                . "{$cmdHelp} — Show this message\n\n"
                . "Data fetched live from upstream."
            );
            break;
    }
}

/** Fetch fresh quota from upstream and send summary to Telegram. */
function sendQuotaReply(string $bot, string $chatId, int $replyTo): void
{
    $q = fetchUpstream();
    if ($q === null) {
        tgReply($bot, $chatId, $replyTo, '❌ Failed to fetch quota data');
        return;
    }

    $used = $q['used'];
    $limit = $q['limit'];
    $remaining = $q['remaining'];
    $pct = $limit > 0 ? round($used / $limit * 100) : 0;
    $totalReq = $q['totalRequests'];
    $model = $q['model'] ?: '?';
    $expired = $q['isExpired'];
    $expiry = $q['expiryDate'] ?: '?';

    // Progress bar (10 blocks)
    $filled = (int)round($pct / 10);
    $bar = str_repeat('█', $filled) . str_repeat('░', 10 - $filled);

    // Color indicator
    if ($pct >= 90) $emoji = '🔴';
    elseif ($pct >= 60) $emoji = '🟠';
    elseif ($pct >= 30) $emoji = '🟡';
    else $emoji = '🟢';

    $resetStr = '—';
    $windowEnd = $q['windowEnd'];
    if ($windowEnd) {
        $endTs = strtotime($windowEnd);
        if ($endTs) {
            $diff = $endTs - time();
            if ($diff > 0) {
                $h = floor($diff / 3600);
                $m = floor(($diff % 3600) / 60);
                $resetStr = sprintf('%02d:%02d', $h, $m) . ' left';
            } else {
                $resetStr = 'Now';
            }
        }
    }

    $updated = (new DateTime('now', tz()))->format('H:i:s');
    $text = "{$emoji} *" . appName() . " — {$model}*\n\n"
        . "`[{$bar}] {$pct}%`\n\n"
        . "Used: " . number_format($used) . "\n"
        . "Remaining: " . number_format($remaining) . "\n"
        . "Limit: " . number_format($limit) . "\n\n"
        . "⏱ Reset window: {$resetStr}\n"
        . "📊 Total requests: " . number_format($totalReq) . "\n"
        . ($expired ? "⛔ *EXPIRED*\n" : "📅 Expires: {$expiry}\n")
        . "_updated: {$updated} " . tzAbbr() . "_";

    tgReply($bot, $chatId, $replyTo, $text);
}

/** Send reset window time info. */
function sendResetReply(string $bot, string $chatId, int $replyTo): void
{
    $q = fetchUpstream();
    if ($q === null) {
        tgReply($bot, $chatId, $replyTo, '❌ Failed to fetch quota data');
        return;
    }

    $windowEnd = $q['windowEnd'];
    $windowStart = $q['windowStart'];
    if (!$windowEnd) {
        tgReply($bot, $chatId, $replyTo, '❌ Window data unavailable');
        return;
    }

    $endTs = strtotime($windowEnd);
    $startTs = $windowStart ? strtotime($windowStart) : false;

    $lines = ["⏱ *Reset Window*\n"];

    if ($startTs) {
        $start = (new DateTime('@' . $startTs))->setTimezone(tz());
        $lines[] = "Start: " . $start->format('H:i:s') . ' ' . tzAbbr();
    }

    $end = (new DateTime('@' . $endTs))->setTimezone(tz());
    $lines[] = "Reset: " . $end->format('H:i:s') . ' ' . tzAbbr();

    $diff = $endTs - time();
    if ($diff > 0) {
        $h = floor($diff / 3600);
        $m = floor(($diff % 3600) / 60);
        $s = $diff % 60;
        $lines[] = "\nRemaining: `{$h}h {$m}m {$s}s`";
    } else {
        $lines[] = "\n🔄 *Resetting now!*";
    }

    $used = $q['used'];
    $limit = $q['limit'];
    $remaining = $q['remaining'];
    $pct = $limit > 0 ? round($used / $limit * 100) : 0;
    $lines[] = "\nTokens used: " . number_format($used) . " / " . number_format($limit) . " ({$pct}%)";
    $lines[] = "Remaining: " . number_format($remaining);
    $lines[] = "\n_updated: " . (new DateTime('now', tz()))->format('H:i:s') . ' ' . tzAbbr() . "_";

    tgReply($bot, $chatId, $replyTo, implode("\n", $lines));
}

/** Reply to a specific Telegram message. */
function tgReply(string $bot, string $chatId, int $replyTo, string $text): bool
{
    $ch = curl_init('https://api.telegram.org/bot' . $bot . '/sendMessage');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => http_build_query([
            'chat_id' => $chatId,
            'text' => $text,
            'parse_mode' => 'Markdown',
            'reply_to_message_id' => $replyTo ?: null,
        ]),
        CURLOPT_TIMEOUT => 10,
    ]);
    $ok = curl_exec($ch);
    $http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return (bool)$ok && $http === 200;
}

/** Send a Telegram message to the configured chat. Returns true on HTTP 200. */
function tgSend(string $text): bool
{
    $e = env();
    $bot = $e['TELEGRAM_BOT_TOKEN'] ?? '';
    $chat = $e['TELEGRAM_CHAT_ID'] ?? '';
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

/* -------------------------------- database -------------------------------- */

function db(): PDO
{
    $e = env();
    $dsn = 'mysql:host=' . ($e['DB_HOST'] ?? '127.0.0.1')
        . ';dbname=' . ($e['DB_DATABASE'] ?? 'quota_dash') . ';charset=utf8mb4';
    return new PDO($dsn, $e['DB_USERNAME'] ?? 'quota_user', $e['DB_PASSWORD'] ?? '', [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    ]);
}
