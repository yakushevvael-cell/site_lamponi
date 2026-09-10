-- Заказы по дням — по всем схемам продаж, а не только со своего склада.
--
-- Таблица orders намеренно остаётся прежней: она держит резервы и потому
-- собирается только из FBS-отправлений. Но на дашборде продавец сравнивает
-- цифры с кабинетом площадки, где считаются и заказы со склада площадки.
-- Поэтому суммы заказов для дашборда живут отдельно и собираются из полного
-- набора: у Wildberries — отчёт «Заказы» статистики, у Ozon — FBS и FBO.
CREATE TABLE `marketplace_daily_orders` (
	`marketplace_id` text NOT NULL,
	`date` text NOT NULL,
	`ordered_amount` real DEFAULT 0 NOT NULL,
	`ordered_net_amount` real DEFAULT 0 NOT NULL,
	`canceled_amount` real DEFAULT 0 NOT NULL,
	`ordered_count` integer DEFAULT 0 NOT NULL,
	`ordered_units` real DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY (`marketplace_id`, `date`)
);--> statement-breakpoint
CREATE INDEX `daily_orders_date_idx` ON `marketplace_daily_orders` (`date`);
