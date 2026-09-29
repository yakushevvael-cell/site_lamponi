-- Обмен с 1С «Ювелирное производство».
--
-- Обмен начинает 1С: внешняя обработка по расписанию ходит в /api/onec/*
-- с ключом в заголовке Authorization. Сайт в 1С не ходит — базу 1С не нужно
-- открывать в интернет, а пароль её пользователя не покидает 1С.
--
-- Ключ хранится только хешем: показывается один раз при выпуске, потерянный
-- ключ не восстанавливают, а выпускают новый (старый при этом отзывается).
CREATE TABLE IF NOT EXISTS `onec_api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`token_hint` text NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`revoked_by` text
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `onec_api_key_hash_unique` ON `onec_api_keys` (`token_hash`);--> statement-breakpoint
-- Что 1С ответила по заданию на сборку. Версия — отпечаток того, что сайт
-- отдал 1С (статус и строки): пока он не изменился, задание в 1С не уходит.
-- Ошибка версию не подтверждает — задание уйдёт снова, например когда в 1С
-- появится недостающий ШК.
CREATE TABLE IF NOT EXISTS `onec_task_sync` (
	`task_id` integer PRIMARY KEY NOT NULL,
	`acked_version` text,
	`document_id` text,
	`document_number` text,
	`document_date` text,
	`last_ok` integer,
	`last_message` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
