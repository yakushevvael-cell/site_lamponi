-- Выкупы и возвраты по дням — из финансовых данных площадок.
--
-- Список отправлений Ozon не содержит даты вручения покупателю, а статус
-- «доставлено» появляется в выгрузке позже самого события. Поэтому суммы
-- выкупов берутся из финансовых операций Ozon и отчёта о продажах
-- Wildberries: там есть и точная дата, и стоимость товара по цене продавца.
-- Хранится агрегат по дням: каждая синхронизация пересчитывает весь период
-- заново и перезаписывает дни целиком.
CREATE TABLE `marketplace_daily_finance` (
	`marketplace_id` text NOT NULL,
	`date` text NOT NULL,
	`buyout_amount` real DEFAULT 0 NOT NULL,
	`buyout_count` integer DEFAULT 0 NOT NULL,
	`buyout_units` real DEFAULT 0 NOT NULL,
	`return_amount` real DEFAULT 0 NOT NULL,
	`return_count` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY (`marketplace_id`, `date`)
);--> statement-breakpoint
CREATE INDEX `daily_finance_date_idx` ON `marketplace_daily_finance` (`date`);
