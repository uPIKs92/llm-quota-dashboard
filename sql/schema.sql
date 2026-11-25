-- GLM quota dashboard — database schema.
-- Idempotent; safe to re-run. Apply with:
--   mysql -u quota_user -p quota_dash < sql/schema.sql
-- or via any MySQL client.

CREATE TABLE IF NOT EXISTS `token_daily_log` (
  `log_date`         date         NOT NULL,
  `tokens_used`      bigint(20)   NOT NULL DEFAULT 0,
  `requests`         int(11)      NOT NULL DEFAULT 0,
  `lifetime_tokens`  bigint(20)   NOT NULL DEFAULT 0,
  `updated_at`       timestamp    NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`log_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Single-row state table for alert dedup. id is pinned to 1.
CREATE TABLE IF NOT EXISTS `alert_state` (
  `id`                       int(11)      NOT NULL DEFAULT 1,
  `last_alerted_window_end`  varchar(40)  DEFAULT NULL,
  `usage_window`             varchar(40)  DEFAULT NULL,
  `alerted_milestones`       varchar(100) DEFAULT NULL,
  `last_window_started_at`   varchar(40)  DEFAULT NULL,
  `known_window_end`         varchar(40)  DEFAULT NULL,
  `current_tpm`              int(11)      NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  CONSTRAINT `alert_state_id_chk` CHECK (`id` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed the single state row so UPDATE ... WHERE id = 1 always matches.
INSERT IGNORE INTO `alert_state` (`id`) VALUES (1);

-- Track the last known upstream window-end so reset alerts (✅) can fire on a
-- time schedule even when the API is idle. Idempotent; safe to re-run.
ALTER TABLE `alert_state`
  ADD COLUMN IF NOT EXISTS `known_window_end` varchar(40) DEFAULT NULL;

-- Stores the last computed tokens-per-minute rate for display. Idempotent.
ALTER TABLE `alert_state`
  ADD COLUMN IF NOT EXISTS `current_tpm` int(11) NOT NULL DEFAULT 0;

-- Unix ts of the most recent genuine 5h window boundary that still needs its
-- replenish ping — one "hi" completion materializes the new window so /stats
-- stops reporting a sliding phantom (used=0) window. Set by maybeAlertResetNow()
-- on boundary cross, cleared by maybeReplenishPing() on success. NULL when no
-- boundary awaits. Idempotent.
ALTER TABLE `alert_state`
  ADD COLUMN IF NOT EXISTS `ping_due_boundary` bigint(20) DEFAULT NULL;

-- Last good normalized upstream payload (JSON). Served flagged stale when the
-- upstream fails (exhausted key, proxy down) so the dashboard keeps rendering
-- the replenish countdown instead of an empty page. Idempotent.
ALTER TABLE `alert_state`
  ADD COLUMN IF NOT EXISTS `last_good_stats` text;

-- 1 when the previous poll saw the quota window exhausted; the exhausted ->
-- available transition triggers the replenish Telegram alert. Idempotent.
ALTER TABLE `alert_state`
  ADD COLUMN IF NOT EXISTS `was_exhausted` tinyint(1) NOT NULL DEFAULT 0;

-- Unix ts of the last replenish-ping attempt (success or failure). One 1-token
-- completion is fired at every genuine 5h boundary to materialize the new
-- upstream window (see ping_due_boundary). Throttled to 5 min.
ALTER TABLE `alert_state`
  ADD COLUMN IF NOT EXISTS `last_ping_ts` bigint(20) NOT NULL DEFAULT 0;

-- One row per 5h quota window; tokens_used = max observed used-in-window.
-- Unix-seconds PK mirrors the alert_state dedup-key convention (timestamp
-- format drift can't duplicate rows). No pruning — ~5 rows/day is negligible.
CREATE TABLE IF NOT EXISTS `token_window_log` (
  `window_start`  bigint(20)   NOT NULL,          -- unix seconds of window_started_at
  `window_end`    bigint(20)   NOT NULL DEFAULT 0,
  `tokens_used`   bigint(20)   NOT NULL DEFAULT 0,
  `updated_at`    timestamp    NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`window_start`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per minute of cumulative lifetime-token counts, used to derive the
-- tokens-per-minute rate. Pruned to the last 24h by the poller. Idempotent.
CREATE TABLE IF NOT EXISTS `token_minute_log` (
  `ts_minute`        datetime     NOT NULL,
  `lifetime_tokens`  bigint(20)   NOT NULL,
  PRIMARY KEY (`ts_minute`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ───────────────────────── RTK Gain (token savings, pulled from vm124) ─────────────────────────
-- Filled by bin/poll-rtk.php from `rtk gain --all --format json`. Bucket rows are
-- NEVER deleted: they are the durable record beyond rtk's own 90-day history.
-- Each poll upserts (last-write-wins): rtk recomputes the current bucket live,
-- past buckets are immutable. Idempotent; safe to re-run.

-- Single-row all-time totals (id pinned to 1).
CREATE TABLE IF NOT EXISTS `rtk_summary` (
  `id`              tinyint(3) unsigned NOT NULL DEFAULT 1,
  `total_commands`  bigint(20) unsigned NOT NULL DEFAULT 0,
  `total_input`     bigint(20) unsigned NOT NULL DEFAULT 0,
  `total_output`    bigint(20) unsigned NOT NULL DEFAULT 0,
  `total_saved`     bigint(20) unsigned NOT NULL DEFAULT 0,
  `avg_savings_pct` decimal(5,2)  NOT NULL DEFAULT 0,
  `fetched_at`      datetime      NOT NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `rtk_summary_id_chk` CHECK (`id` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `rtk_daily` (
  `log_date`      date          NOT NULL,
  `commands`      int(10) unsigned NOT NULL DEFAULT 0,
  `input_tokens`  bigint(20) unsigned NOT NULL DEFAULT 0,
  `output_tokens` bigint(20) unsigned NOT NULL DEFAULT 0,
  `saved_tokens`  bigint(20) unsigned NOT NULL DEFAULT 0,
  `savings_pct`   decimal(5,2)  NOT NULL DEFAULT 0,
  `updated_at`    datetime      NOT NULL,
  PRIMARY KEY (`log_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `rtk_weekly` (
  `week_start`    date          NOT NULL,
  `week_end`      date          NULL,
  `commands`      int(10) unsigned NOT NULL DEFAULT 0,
  `input_tokens`  bigint(20) unsigned NOT NULL DEFAULT 0,
  `output_tokens` bigint(20) unsigned NOT NULL DEFAULT 0,
  `saved_tokens`  bigint(20) unsigned NOT NULL DEFAULT 0,
  `savings_pct`   decimal(5,2)  NOT NULL DEFAULT 0,
  `updated_at`    datetime      NOT NULL,
  PRIMARY KEY (`week_start`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `rtk_monthly` (
  `log_month`     char(7)       NOT NULL,   -- 'YYYY-MM'
  `commands`      int(10) unsigned NOT NULL DEFAULT 0,
  `input_tokens`  bigint(20) unsigned NOT NULL DEFAULT 0,
  `output_tokens` bigint(20) unsigned NOT NULL DEFAULT 0,
  `saved_tokens`  bigint(20) unsigned NOT NULL DEFAULT 0,
  `savings_pct`   decimal(5,2)  NOT NULL DEFAULT 0,
  `updated_at`    datetime      NOT NULL,
  PRIMARY KEY (`log_month`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Latest raw rtk JSON payload (id pinned to 1), kept for debugging/reprocessing.
CREATE TABLE IF NOT EXISTS `rtk_raw` (
  `id`          tinyint(3) unsigned NOT NULL DEFAULT 1,
  `payload`     mediumtext,
  `fetched_at`  datetime NOT NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `rtk_raw_id_chk` CHECK (`id` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
