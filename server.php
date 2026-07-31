<?php
$env = parse_ini_file(__DIR__ . '/.env');
$key = $env['GLM_API_KEY'] ?? getenv('GLM_API_KEY');
if (!$key) { http_response_code(500); exit('GLM_API_KEY not set'); }

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path === '/api/stats') {
    $ch = curl_init('https://glm.ajianaz.dev/stats');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $key],
        CURLOPT_TIMEOUT => 15,
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    http_response_code($code ?: 500);
    header('Content-Type: application/json');
    exit($body ?: '{"error":"upstream failed"}');
}
header('Content-Type: text/html; charset=utf-8');
readfile(__DIR__ . '/index.html');
