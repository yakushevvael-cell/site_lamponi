-- Этап 3 и 4 складского модуля: УПД с УИНами, этикетки, стол сканирования.
--
-- Этикетки готовятся заранее и лежат файлами на диске (как ОСВ), в базе
-- только ключ файла: 400 этикеток в день в базе раздули бы её без пользы.

CREATE TABLE `upd_uploads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_name` text NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`new_count` integer DEFAULT 0 NOT NULL,
	`uploaded_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
-- УИН → артикул. Источник — УПД из 1С: в ней «Код товара» даёт артикул,
-- а УИН лежит в наименовании товара.
CREATE TABLE `uin_items` (
	`uin` text PRIMARY KEY NOT NULL,
	`article` text NOT NULL,
	`size` text,
	`description` text,
	`upload_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`used_marketplace_id` text,
	`used_external_order_id` text,
	`used_task_id` integer,
	`used_at` text,
	`used_by` text
);
--> statement-breakpoint
CREATE INDEX `uin_item_article_idx` ON `uin_items` (`article`, `size`);
--> statement-breakpoint
CREATE INDEX `uin_item_used_idx` ON `uin_items` (`used_external_order_id`);
--> statement-breakpoint
-- Этикетка отправления. Готовится фоном до того, как товар дойдёт до стола:
-- на столе остаётся только скан и печать, без обращений к API площадки.
CREATE TABLE `shipment_labels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`marketplace_id` text NOT NULL,
	`external_order_id` text NOT NULL,
	`task_id` integer,
	`article` text,
	`size` text,
	`uin` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`content_type` text,
	`storage_key` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`prepared_at` text,
	`printed_at` text,
	`print_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shipment_label_posting_unique` ON `shipment_labels` (`marketplace_id`, `external_order_id`);
--> statement-breakpoint
CREATE INDEX `shipment_label_status_idx` ON `shipment_labels` (`status`, `created_at`);
--> statement-breakpoint
-- Отметки стола сканирования в строке задания: по ним считается очередь
-- на упаковке и скорость работы.
ALTER TABLE `pick_task_items` ADD `uin` text;
--> statement-breakpoint
ALTER TABLE `pick_task_items` ADD `scanned_at` text;
--> statement-breakpoint
ALTER TABLE `pick_task_items` ADD `scanned_by` text;
--> statement-breakpoint
ALTER TABLE `pick_task_items` ADD `label_printed_at` text;
--> statement-breakpoint
-- Отмена сборочного задания WB через API: отметка, что отмена уже прошла.
ALTER TABLE `problem_articles` ADD `cancelled_on_marketplace_at` text;
