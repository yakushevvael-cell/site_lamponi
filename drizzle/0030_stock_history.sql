-- История остатков по позиции: проверка площадок после корректировки.
--
-- Через 10 минут после того, как остаток по позиции уехал на площадки
-- (доотправка после заказов или ручная выгрузка выбранных), сервис сам
-- читает, что теперь лежит на складах WB, Ozon и Яндекс Маркета. Чтение
-- складывается сюда: без этого «что было на площадке» знал только тот, кто
-- в тот момент нажал «Что на площадке».
CREATE TABLE IF NOT EXISTS `stock_remote_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text,
	`product_sku` text NOT NULL,
	`trigger` text NOT NULL,
	`due_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`checked_at` text,
	`message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `stock_remote_check_due_idx` ON `stock_remote_checks` (`status`, `due_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `stock_remote_check_sku_idx` ON `stock_remote_checks` (`product_sku`, `created_at`);--> statement-breakpoint
-- Одна строка — один склад площадки. expected_qty — что сервис отправил на
-- этот склад при корректировке; пусто, если на склад ничего не уходило.
CREATE TABLE IF NOT EXISTS `stock_remote_check_rows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`check_id` integer NOT NULL,
	`marketplace_id` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`warehouse_name` text,
	`publishing` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`amount` integer,
	`reserved` integer,
	`expected_qty` integer,
	`message` text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `stock_remote_check_row_check_idx` ON `stock_remote_check_rows` (`check_id`);
