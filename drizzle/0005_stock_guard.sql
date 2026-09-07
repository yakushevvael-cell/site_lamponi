-- Реестр складов: разделение «активен в кабинете» и «выгрузка включена» (ТЗ, п. 4)
ALTER TABLE `marketplace_warehouses` RENAME COLUMN `enabled` TO `remote_active`;--> statement-breakpoint
ALTER TABLE `marketplace_warehouses` ADD `remote_status` text;--> statement-breakpoint
ALTER TABLE `marketplace_warehouses` ADD `sync_status` text DEFAULT 'never' NOT NULL;--> statement-breakpoint
ALTER TABLE `marketplace_warehouses` ADD `sync_error` text;--> statement-breakpoint
ALTER TABLE `marketplace_warehouses` ADD `publish_enabled_by` text;--> statement-breakpoint
ALTER TABLE `marketplace_warehouses` ADD `publish_enabled_at` text;--> statement-breakpoint
ALTER TABLE `marketplace_warehouses` ADD `last_checked_at` text;--> statement-breakpoint

-- Ни один склад не должен выгружать остатки, пока администратор не включит его заново.
-- После аварии с завышенными остатками это единственное безопасное исходное состояние.
UPDATE `marketplace_warehouses` SET `publish_full_stock` = 0;--> statement-breakpoint

-- Журнал синхронизации (ТЗ, п. 12)
CREATE TABLE `stock_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`trigger` text NOT NULL,
	`osv_upload_id` integer,
	`actor_email` text,
	`message` text,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`osv_upload_id`) REFERENCES `osv_uploads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stock_sync_run_started_idx` ON `stock_sync_runs` (`started_at`);--> statement-breakpoint

CREATE TABLE `stock_sync_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`marketplace_id` text NOT NULL,
	`warehouse_id` text,
	`product_sku` text,
	`external_sku` text,
	`article` text,
	`size` text,
	`osv_qty` real,
	`reserve_qty` real,
	`computed_qty` real,
	`sent_qty` real,
	`api_status` text NOT NULL,
	`api_message` text,
	`actor_email` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stock_sync_log_run_idx` ON `stock_sync_log` (`run_id`);--> statement-breakpoint
CREATE INDEX `stock_sync_log_created_idx` ON `stock_sync_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `stock_sync_log_article_idx` ON `stock_sync_log` (`article`,`size`);
