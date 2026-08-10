#!/usr/bin/env php
<?php
/**
 * Register the Telegram webhook so bot commands reach server.php.
 *
 * Reads WEBHOOK_URL and TELEGRAM_WEBHOOK_SECRET from .env, then calls
 * Telegram setWebhook. Run once after the public HTTPS URL is live
 * (e.g. once the Cloudflare tunnel is up):
 *
 *   php bin/set-webhook.php
 */

require __DIR__ . '/../server.php';

$env = parse_ini_file(__DIR__ . '/../.env');
$bot = $env['TELEGRAM_BOT_TOKEN'] ?? '';
$url = rtrim($env['WEBHOOK_URL'] ?? '', '/');
$secret = $env['TELEGRAM_WEBHOOK_SECRET'] ?? '';

if (!$bot) {
    fwrite(STDERR, "TELEGRAM_BOT_TOKEN not set in .env\n");
    exit(1);
}
if (!$url) {
    fwrite(STDERR, "WEBHOOK_URL not set in .env\n");
    fwrite(STDERR, "Set it to your public HTTPS base, e.g. https://quota.example.com\n");
    exit(1);
}

$webhookUrl = $url . '/api/tg/webhook';

$params = [
    'url' => $webhookUrl,
    'allowed_updates' => json_encode(['message']),
];
if ($secret !== '') {
    $params['secret_token'] = $secret;
}

$ch = curl_init('https://api.telegram.org/bot' . $bot . '/setWebhook');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => http_build_query($params),
    CURLOPT_TIMEOUT => 15,
]);
$body = curl_exec($ch);
$code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

fwrite(STDOUT, "setWebhook -> HTTP {$code}\n{$body}\n");

$ok = ($code === 200 && (json_decode($body, true)['ok'] ?? false));
if ($ok) {
    fwrite(STDOUT, "\nWebhook registered: {$webhookUrl}\n");
    if ($secret !== '') {
        fwrite(STDOUT, "Secret token enabled.\n");
    }
    exit(0);
}
exit(1);
