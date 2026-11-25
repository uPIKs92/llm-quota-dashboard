-- One-time migration: single-host rtk_* tables -> per-host tables.
-- Apply ONCE to a database created before multi-host RTK support. Fresh installs
-- use sql/schema.sql directly. Re-running is NOT safe (the PKs are rebuilt and
-- the id column is dropped on the first run).
--
--   SET @legacy_host = 'local';   -- host id the existing rows came from
--   SOURCE sql/migrate-rtk-multi-host.sql;   (or pipe through mysql with the SET first)

-- rtk_summary: id (singleton) -> host
ALTER TABLE `rtk_summary` ADD COLUMN IF NOT EXISTS `host` varchar(32) NULL;
UPDATE `rtk_summary` SET `host` = @legacy_host WHERE `host` IS NULL;
ALTER TABLE `rtk_summary` DROP PRIMARY KEY, DROP COLUMN `id`,
  MODIFY `host` varchar(32) NOT NULL, ADD PRIMARY KEY (`host`);

-- rtk_raw: id (singleton) -> host
ALTER TABLE `rtk_raw` ADD COLUMN IF NOT EXISTS `host` varchar(32) NULL;
UPDATE `rtk_raw` SET `host` = @legacy_host WHERE `host` IS NULL;
ALTER TABLE `rtk_raw` DROP PRIMARY KEY, DROP COLUMN `id`,
  MODIFY `host` varchar(32) NOT NULL, ADD PRIMARY KEY (`host`);

-- Buckets: add host, then widen the primary key to (host, bucket)
ALTER TABLE `rtk_daily` ADD COLUMN IF NOT EXISTS `host` varchar(32) NULL;
UPDATE `rtk_daily` SET `host` = @legacy_host WHERE `host` IS NULL;
ALTER TABLE `rtk_daily` DROP PRIMARY KEY, MODIFY `host` varchar(32) NOT NULL,
  ADD PRIMARY KEY (`host`, `log_date`);

ALTER TABLE `rtk_weekly` ADD COLUMN IF NOT EXISTS `host` varchar(32) NULL;
UPDATE `rtk_weekly` SET `host` = @legacy_host WHERE `host` IS NULL;
ALTER TABLE `rtk_weekly` DROP PRIMARY KEY, MODIFY `host` varchar(32) NOT NULL,
  ADD PRIMARY KEY (`host`, `week_start`);

ALTER TABLE `rtk_monthly` ADD COLUMN IF NOT EXISTS `host` varchar(32) NULL;
UPDATE `rtk_monthly` SET `host` = @legacy_host WHERE `host` IS NULL;
ALTER TABLE `rtk_monthly` DROP PRIMARY KEY, MODIFY `host` varchar(32) NOT NULL,
  ADD PRIMARY KEY (`host`, `log_month`);
