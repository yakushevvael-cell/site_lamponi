-- Отправления Ozon с несколькими товарами и подтверждение размера на WB.
--
-- В отправлении Ozon может быть несколько изделий. Печатать этикетку по
-- первому же скану нельзя: этикетка одна на отправление, а передать в Ozon
-- надо УИН каждого изделия и только потом собирать отправление целиком.
-- Поэтому такие изделия на столе откладываются в отдельную ячейку
-- комплектации — по одной на отправление, — и этикетка печатается, когда
-- отсканировано всё отправление.

CREATE TABLE `posting_slots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`marketplace_id` text NOT NULL,
	`external_order_id` text NOT NULL,
	`slot` integer NOT NULL,
	`items_total` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
-- Одно отправление — одна ячейка комплектации, и номер ячейки не повторяется
-- в пределах задания: запрет стоит в базе, чтобы два стола не получили одну.
CREATE UNIQUE INDEX `posting_slot_posting_unique` ON `posting_slots` (`task_id`,`marketplace_id`,`external_order_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `posting_slot_number_unique` ON `posting_slots` (`task_id`,`slot`);
--> statement-breakpoint
-- На Wildberries размер у заказа есть («16-20», «б/р»), а в УПД его нет.
-- Кладовщик подтверждает такое расхождение руками, и подтверждение остаётся
-- в строке задания: потом по нему видно, кто разрешил отгрузку.
ALTER TABLE `pick_task_items` ADD `size_confirmed_at` text;
--> statement-breakpoint
ALTER TABLE `pick_task_items` ADD `size_confirmed_by` text;
--> statement-breakpoint
ALTER TABLE `pick_task_items` ADD `size_confirmed_value` text;
