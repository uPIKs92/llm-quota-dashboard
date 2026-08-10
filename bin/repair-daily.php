#!/usr/bin/env php
<?php
/**
 * One-time repair: recompute token_daily_log.tokens_used as true daily deltas.
 *
 * Background: a bug froze the per-day lifetime anchor, so tokens_used became
 * cumulative instead of per-day. This recalculates each day's delta as the
 * consecutive difference and re-anchors today's row so the fixed logDaily()
 * update path stays consistent going forward.
 *
 *   php bin/repair-daily.php
 */

require __DIR__ . '/../server.php';

$pdo = db();

$rows = $pdo->query('SELECT log_date, tokens_used, lifetime_tokens FROM token_daily_log ORDER BY log_date ASC')
    ->fetchAll(PDO::FETCH_ASSOC);

if (!$rows) {
    fwrite(STDOUT, "No rows to repair.\n");
    exit(0);
}

$today = date('Y-m-d');
$prevCumulative = null;
$repaired = 0;

$updDelta = $pdo->prepare('UPDATE token_daily_log SET tokens_used = ? WHERE log_date = ?');
$updAnchor = $pdo->prepare('UPDATE token_daily_log SET lifetime_tokens = ? WHERE log_date = ?');

foreach ($rows as $row) {
    // tokens_used is currently cumulative-since-frozen-anchor
    $cumulative = (int)$row['tokens_used'];
    $date = $row['log_date'];

    if ($prevCumulative === null) {
        // oldest row: keep as baseline (its own first-day usage)
        $prevCumulative = $cumulative;
        fwrite(STDOUT, "{$date}: baseline cumulative={$cumulative} (kept)\n");
        continue;
    }

    $daily = max($cumulative - $prevCumulative, 0);
    $updDelta->execute([$daily, $date]);
    $repaired++;
    fwrite(STDOUT, "{$date}: cumulative={$cumulative} -> daily={$daily}\n");

    // Re-anchor today's row so future update-path deltas match.
    // actual current lifetime = frozen anchor + original cumulative
    if ($date === $today) {
        $actualLifetime = (int)$row['lifetime_tokens'] + $cumulative;
        $newAnchor = max($actualLifetime - $daily, 0);
        $updAnchor->execute([$newAnchor, $today]);
        fwrite(STDOUT, "    re-anchored lifetime_tokens={$newAnchor}\n");
    }

    $prevCumulative = $cumulative;
}

fwrite(STDOUT, "\nRepaired {$repaired} day(s).\n");
