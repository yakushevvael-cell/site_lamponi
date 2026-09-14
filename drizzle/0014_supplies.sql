-- Этап 5: оформление поставок. Один склад = одна поставка.

CREATE TABLE `dropoff_points` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`marketplace_id` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`address` text,
	`active` integer DEFAULT 1 NOT NULL,
	`last_used_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dropoff_point_unique` ON `dropoff_points` (`marketplace_id`, `external_id`);
--> statement-breakpoint
CREATE TABLE `supplies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`marketplace_id` text NOT NULL,
	`task_id` integer,
	`external_id` text,
	`name` text,
	`status` text DEFAULT 'created' NOT NULL,
	`box_count` integer DEFAULT 1 NOT NULL,
	`posting_count` integer DEFAULT 0 NOT NULL,
	`dropoff_point_id` integer,
	`dropoff_name` text,
	`documents_json` text DEFAULT '[]' NOT NULL,
	`error` text,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`closed_at` text
);
--> statement-breakpoint
CREATE INDEX `supply_task_idx` ON `supplies` (`task_id`);
--> statement-breakpoint
CREATE INDEX `supply_created_idx` ON `supplies` (`created_at`);
--> statement-breakpoint
ALTER TABLE `pick_tasks` ADD `supply_id` integer;
