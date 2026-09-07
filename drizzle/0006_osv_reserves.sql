-- Дата, на которую актуальна ОСВ. Нужна, чтобы гасить резерв только по тем
-- отгрузкам, которые эта ОСВ уже учла (ТЗ, п. 7).
ALTER TABLE `osv_uploads` ADD `balance_date` text;--> statement-breakpoint
-- Признак загрузки, принятой администратором несмотря на расхождение итогов.
ALTER TABLE `osv_uploads` ADD `accepted_with_blockers` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `osv_uploads` ADD `blockers_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint

-- Существующим загрузкам проставляем дату по времени загрузки: другой у нас нет.
UPDATE `osv_uploads` SET `balance_date` = `created_at` WHERE `balance_date` IS NULL;--> statement-breakpoint

-- Статус заказа на момент пересчёта — чтобы в журнале было видно, почему резерв снят.
ALTER TABLE `stock_reservations` ADD `order_status` text;
