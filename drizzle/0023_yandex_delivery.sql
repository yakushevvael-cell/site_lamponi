-- Заявки Яндекс Доставки по заказам Маркета (модель DBS).
--
-- На DBS доставку организует продавец: по собранному заказу создаётся заявка
-- на курьера, и её номер (request_id) уходит в Маркет трек-номером. После
-- этого Маркет сам доводит заказ до «доставлен» или «отменён».
--
-- Номер заявки нужно хранить у себя: повторное оформление отгрузки не должно
-- создавать второго курьера на тот же заказ, а при отмене заказа заявку надо
-- чем-то отменять. Одна заявка на заказ — это и есть ограничение в индексе.
CREATE TABLE `delivery_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`marketplace_id` text NOT NULL,
	`external_order_id` text NOT NULL,
	`task_id` integer,
	`supply_id` integer,
	`offer_id` text,
	`request_id` text,
	`status` text DEFAULT 'created' NOT NULL,
	`error` text,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`confirmed_at` text,
	`cancelled_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_request_order_unique` ON `delivery_requests` (`marketplace_id`,`external_order_id`);--> statement-breakpoint
CREATE INDEX `delivery_request_task_idx` ON `delivery_requests` (`task_id`);
