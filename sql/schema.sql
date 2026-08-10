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
  PRIMARY KEY (`id`),
  CONSTRAINT `alert_state_id_chk` CHECK (`id` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed the single state row so UPDATE ... WHERE id = 1 always matches.
INSERT IGNORE INTO `alert_state` (`id`) VALUES (1);
