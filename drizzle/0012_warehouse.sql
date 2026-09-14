-- Складской модуль: ячейки, раскладка, задания на сборку, проблемные товары,
-- журнал событий процесса и права набором галочек.
--
-- Журнал событий пишется с первого дня, даже пока отчётов ещё нет: к моменту
-- появления хронометража в базе уже будет история для сравнения.

CREATE TABLE `user_permissions` (
	`email` text NOT NULL,
	`code` text NOT NULL,
	`granted_by` text,
	`granted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`email`, `code`)
);
--> statement-breakpoint
CREATE TABLE `warehouse_cells` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`zone` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `warehouse_cell_code_unique` ON `warehouse_cells` (`code`);
--> statement-breakpoint
CREATE INDEX `warehouse_cell_sort_idx` ON `warehouse_cells` (`sort_order`, `code`);
--> statement-breakpoint
CREATE TABLE `cell_placements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`article` text NOT NULL,
	`size` text,
	`cell_id` integer NOT NULL REFERENCES `warehouse_cells`(`id`) ON DELETE cascade,
	`updated_by` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cell_placement_article_size_unique` ON `cell_placements` (`article`, COALESCE(`size`, ''));
--> statement-breakpoint
CREATE INDEX `cell_placement_cell_idx` ON `cell_placements` (`cell_id`);
--> statement-breakpoint
CREATE TABLE `pick_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`number` text NOT NULL,
	`marketplace_id` text NOT NULL,
	`warehouse_external_id` text,
	`warehouse_name` text,
	`status` text DEFAULT 'created' NOT NULL,
	`assignee_email` text,
	`order_count` integer DEFAULT 0 NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`unit_count` real DEFAULT 0 NOT NULL,
	`picked_count` integer DEFAULT 0 NOT NULL,
	`not_found_count` integer DEFAULT 0 NOT NULL,
	`cell_count` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`issued_at` text,
	`picked_at` text,
	`shipped_at` text,
	`cancelled_at` text,
	`printed_at` text,
	`comment` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pick_task_number_unique` ON `pick_tasks` (`number`);
--> statement-breakpoint
CREATE INDEX `pick_task_status_idx` ON `pick_tasks` (`status`, `created_at`);
--> statement-breakpoint
CREATE INDEX `pick_task_assignee_idx` ON `pick_tasks` (`assignee_email`, `status`);
--> statement-breakpoint
CREATE TABLE `pick_task_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL REFERENCES `pick_tasks`(`id`) ON DELETE cascade,
	`marketplace_id` text NOT NULL,
	`external_order_id` text NOT NULL,
	`external_sku` text NOT NULL,
	`product_sku` text,
	`article` text NOT NULL,
	`size` text,
	`quantity` real DEFAULT 1 NOT NULL,
	`cell_code` text,
	`cell_sort` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`ordered_at` text,
	`shipment_deadline` text,
	`resolved_by` text,
	`resolved_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
-- Один и тот же товар одного отправления не может попасть в два задания:
-- запрет на уровне базы, а не проверкой в коде.
CREATE UNIQUE INDEX `pick_task_item_posting_unique` ON `pick_task_items` (`marketplace_id`, `external_order_id`, `external_sku`);
--> statement-breakpoint
CREATE INDEX `pick_task_item_task_idx` ON `pick_task_items` (`task_id`, `cell_sort`);
--> statement-breakpoint
CREATE INDEX `pick_task_item_article_idx` ON `pick_task_items` (`article`, `size`);
--> statement-breakpoint
CREATE TABLE `problem_articles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`article` text NOT NULL,
	`size` text,
	`product_sku` text,
	`state` text DEFAULT 'blocked' NOT NULL,
	`status` text DEFAULT 'searching' NOT NULL,
	`osv_qty_at_block` real DEFAULT 0 NOT NULL,
	`failed_order_count` integer DEFAULT 0 NOT NULL,
	`task_id` integer,
	`task_number` text,
	`marketplace_id` text,
	`external_order_id` text,
	`shipment_deadline` text,
	`blocked_by` text,
	`blocked_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`released_by` text,
	`released_at` text,
	`comment` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `problem_article_open_unique` ON `problem_articles` (`article`, COALESCE(`size`, '')) WHERE `state` = 'blocked';
--> statement-breakpoint
CREATE INDEX `problem_article_state_idx` ON `problem_articles` (`state`, `blocked_at`);
--> statement-breakpoint
-- Журнал блокировок и снятий. Удаление строк не предусмотрено.
CREATE TABLE `problem_article_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`article` text NOT NULL,
	`size` text,
	`action` text NOT NULL,
	`actor_email` text,
	`comment` text,
	`task_number` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `problem_article_log_article_idx` ON `problem_article_log` (`article`, `created_at`);
--> statement-breakpoint
CREATE TABLE `warehouse_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`task_id` integer,
	`task_number` text,
	`marketplace_id` text,
	`external_order_id` text,
	`article` text,
	`size` text,
	`quantity` real,
	`actor_email` text,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `warehouse_event_created_idx` ON `warehouse_events` (`created_at`);
--> statement-breakpoint
CREATE INDEX `warehouse_event_kind_idx` ON `warehouse_events` (`kind`, `created_at`);
--> statement-breakpoint
CREATE INDEX `warehouse_event_task_idx` ON `warehouse_events` (`task_id`);
--> statement-breakpoint
-- Дедлайн отгрузки отправления: у Ozon это плановая дата отгрузки, по ней
-- считаем, что горит. Раньше поле не сохранялось.
ALTER TABLE `orders` ADD `shipment_deadline` text;
