<?php
$env = parse_ini_file(__DIR__ . '/.env');
$key = $env['GLM_API_KEY'] ?? getenv('GLM_API_KEY');

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

/**
 * Fetch quota from upstream, log daily stats, and fire any pending alerts.
 * Called by the /api/stats HTTP handler and by bin/poll.php (cron).
 *
 * @return array{code:int, body:string}
 */
function pollQuota(): array
{
    $env = parse_ini_file(__DIR__ . '/.env');
    $key = $env['GLM_API_KEY'] ?? getenv('GLM_API_KEY');
    if (!$key) {
        return ['code' => 500, 'body' => '{"error":"GLM_API_KEY not set"}'];
    }

    $ch = curl_init('https://glm.ajianaz.dev/stats');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $key],
        CURLOPT_TIMEOUT => 15,
    ]);
    $body = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
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
    if ($start <= $lastTs) return; // not a newer window than what we already logged

    $wib = new DateTimeZone('Asia/Jakarta');
    $startFmt = (new DateTime('@' . $start))->setTimezone($wib)->format('H:i');
    $elapsedMin = (int)max((time() - $start) / 60, 0);
    $text = "✅ *Quota GLM sudah reset*\\n"
        . "Window baru dimulai: " . $startFmt . " WIB\\n"
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
        . "Reset: " . (new DateTime('@' . $windowEnd))->setTimezone(new DateTimeZone('Asia/Jakarta'))->format('H:i') . " WIB\n";

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

/**
 * Handle incoming Telegram bot commands.
 */
function handleTgCommand(array $update): void
{
    $env = parse_ini_file(__DIR__ . '/.env');
    $bot = $env['TELEGRAM_BOT_TOKEN'] ?? '';
    $authChat = $env['TELEGRAM_CHAT_ID'] ?? '';
    if (!$bot || !$authChat) return;

    $msg = $update['message'];
    $chatId = (string)($msg['chat']['id'] ?? '');
    $text = trim($msg['text'] ?? '');
    $msgId = (int)($msg['message_id'] ?? 0);

    // Security: only respond to authorized chat
    if ($chatId !== $authChat) return;

    // Extract command (strip @botname suffix)
    $cmd = explode(' ', $text)[0];
    $cmd = strtolower(preg_replace('/@.*$/', '', $cmd));

    switch ($cmd) {
        case '/glmquota':
        case '/glm':
            sendQuotaReply($bot, $chatId, $msgId);
            break;
        case '/glmreset':
            sendResetReply($bot, $chatId, $msgId);
            break;
        case '/glmhelp':
            tgReply($bot, $chatId, $msgId,
                "🤖 *GLM Bot Commands*\n\n"
                . "/glmquota, /glm — Cek pemakaian kuota\n"
                . "/glmreset — Cek waktu reset\n"
                . "/glmhelp — Tampilkan pesan ini\n\n"
                . "Data diambil realtime dari API."
            );
            break;
    }
}

/** Fetch fresh quota from upstream and send summary to Telegram. */
function sendQuotaReply(string $bot, string $chatId, int $replyTo): void
{
    $env = parse_ini_file(__DIR__ . '/.env');
    $key = $env['GLM_API_KEY'] ?? '';
    if (!$key) {
        tgReply($bot, $chatId, $replyTo, '❌ API key tidak dikonfigurasi');
        return;
    }

    $ch = curl_init('https://glm.ajianaz.dev/stats');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $key],
        CURLOPT_TIMEOUT => 15,
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($code !== 200 || !$body) {
        tgReply($bot, $chatId, $replyTo, '❌ Gagal mengambil data dari API');
        return;
    }

    $data = json_decode($body, true);
    if (!is_array($data)) {
        tgReply($bot, $chatId, $replyTo, '❌ Response API tidak valid');
        return;
    }

    $used = (int)($data['current_usage']['tokens_used_in_current_window'] ?? 0);
    $limit = (int)($data['token_limit_per_5h'] ?? 0);
    $remaining = (int)($data['current_usage']['remaining_tokens'] ?? 0);
    $pct = $limit > 0 ? round($used / $limit * 100) : 0;
    $totalReq = (int)($data['total_requests'] ?? 0);
    $model = $data['model'] ?? '?';
    $expired = !empty($data['is_expired']);
    $expiry = $data['expiry_date'] ?? '?';

    // Progress bar (10 blocks)
    $filled = round($pct / 10);
    $bar = str_repeat('█', $filled) . str_repeat('░', 10 - $filled);

    // Color indicator
    if ($pct >= 90) $emoji = '🔴';
    elseif ($pct >= 60) $emoji = '🟠';
    elseif ($pct >= 30) $emoji = '🟡';
    else $emoji = '🟢';

    $wib = new DateTimeZone('Asia/Jakarta');
    $windowEnd = $data['current_usage']['window_ends_at'] ?? null;
    $resetStr = '—';
    if ($windowEnd) {
        $endTs = strtotime($windowEnd);
        if ($endTs) {
            $diff = $endTs - time();
            if ($diff > 0) {
                $h = floor($diff / 3600);
                $m = floor(($diff % 3600) / 60);
                $resetStr = sprintf('%02d:%02d', $h, $m) . ' lagi';
            } else {
                $resetStr = 'Sekarang';
            }
        }
    }

    $text = "{$emoji} *Kuota GLM — {$model}*\n\n"
        . "`[{$bar}] {$pct}%`\n\n"
        . "Terpakai: " . number_format($used, 0, ',', '.') . "\n"
        . "Sisa: " . number_format($remaining, 0, ',', '.') . "\n"
        . "Limit: " . number_format($limit, 0, ',', '.') . "\n\n"
        . "⏱ Reset window: {$resetStr}\n"
        . "📊 Total request: " . number_format($totalReq, 0, ',', '.') . "\n"
        . ($expired ? "⛔ *EXPIRED*\n" : "📅 Expired: {$expiry}\n")
        . "_diupdate: " . (new DateTime('now', $wib))->format('H:i:s') . " WIB_";

    tgReply($bot, $chatId, $replyTo, $text);
}

/** Send reset window time info. */
function sendResetReply(string $bot, string $chatId, int $replyTo): void
{
    $env = parse_ini_file(__DIR__ . '/.env');
    $key = $env['GLM_API_KEY'] ?? '';
    if (!$key) {
        tgReply($bot, $chatId, $replyTo, '❌ API key tidak dikonfigurasi');
        return;
    }

    $ch = curl_init('https://glm.ajianaz.dev/stats');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $key],
        CURLOPT_TIMEOUT => 15,
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($code !== 200 || !$body) {
        tgReply($bot, $chatId, $replyTo, '❌ Gagal mengambil data dari API');
        return;
    }

    $data = json_decode($body, true);
    if (!is_array($data)) {
        tgReply($bot, $chatId, $replyTo, '❌ Response API tidak valid');
        return;
    }

    $wib = new DateTimeZone('Asia/Jakarta');
    $windowEnd = $data['current_usage']['window_ends_at'] ?? null;
    $windowStart = $data['current_usage']['window_started_at'] ?? null;

    if (!$windowEnd) {
        tgReply($bot, $chatId, $replyTo, '❌ Data window tidak tersedia');
        return;
    }

    $endTs = strtotime($windowEnd);
    $startTs = $windowStart ? strtotime($windowStart) : false;

    $lines = ["⏱ *Reset Window*\n"];

    if ($startTs) {
        $start = (new DateTime('@' . $startTs))->setTimezone($wib);
        $lines[] = "Mulai: " . $start->format('H:i:s') . " WIB";
    }

    $end = (new DateTime('@' . $endTs))->setTimezone($wib);
    $lines[] = "Reset: " . $end->format('H:i:s') . " WIB";

    $diff = $endTs - time();
    if ($diff > 0) {
        $h = floor($diff / 3600);
        $m = floor(($diff % 3600) / 60);
        $s = $diff % 60;
        $lines[] = "\nSisa: `{$h} jam {$m} menit {$s} detik`";
    } else {
        $lines[] = "\n🔄 *Reset sekarang!*";
    }

    $used = (int)($data['current_usage']['tokens_used_in_current_window'] ?? 0);
    $limit = (int)($data['token_limit_per_5h'] ?? 0);
    $remaining = (int)($data['current_usage']['remaining_tokens'] ?? 0);
    $pct = $limit > 0 ? round($used / $limit * 100) : 0;
    $lines[] = "\nToken terpakai: " . number_format($used, 0, ',', '.') . " / " . number_format($limit, 0, ',', '.') . " ({$pct}%)";
    $lines[] = "Sisa token: " . number_format($remaining, 0, ',', '.');
    $lines[] = "\n_diupdate: " . (new DateTime('now', $wib))->format('H:i:s') . " WIB_";

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
