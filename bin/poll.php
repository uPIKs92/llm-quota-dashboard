#!/usr/bin/env php
<?php
/**
 * Cron entry point: poll upstream quota, log daily stats, fire alerts.
 *
 * Add to crontab (every minute):
 *   * * * * * php /var/www/html/glm-quota-dashboard/bin/poll.php >> /tmp/glm-poll.log 2>&1
 */

require __DIR__ . '/../server.php';

$result = pollQuota(true);
$ts = date('c');
if ($result['code'] === 200) {
    fwrite(STDOUT, "[{$ts}] poll ok\n");
} else {
    fwrite(STDERR, "[{$ts}] poll failed: HTTP {$result['code']}\n");
    exit(1);
}
