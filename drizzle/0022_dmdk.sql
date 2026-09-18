-- ГИИС ДМДК: настройки по площадкам, кэш справочников и спецификации.
--
-- Настройки хранятся отдельно для каждой площадки: грузополучатель, контракт и
-- перевозчик у WB и Ozon разные, а перепутанный получатель означает не ошибку
-- на экране, а непринятую спецификацию и остановку отгрузки.
--
-- Значения полей — не текст, который ввели руками, а идентификаторы из
-- справочников самой ГИИС: только так реквизиты спецификации совпадут с тем,
-- что система ожидает. Поэтому рядом лежит кэш справочников.
CREATE TABLE `dmdk_settings` (
	`marketplace_id` text PRIMARY KEY NOT NULL,
	`shipper_ogrn` text,
	`shipper_name` text,
	`consignee_ogrn` text,
	`consignee_name` text,
	`deal_id` text,
	`deal_number` text,
	`carrier_ogrn` text,
	`carrier_name` text,
	`amount_type` text DEFAULT 'P_SALE' NOT NULL,
	`currency` text DEFAULT 'RUB' NOT NULL,
	`vat_rate` text DEFAULT 'NDS_22' NOT NULL,
	`price_source` text DEFAULT 'order' NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`updated_by` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
-- Кэш справочников ГИИС.
--
-- Списки в настройках заполняются отсюда, а не из памяти человека. Если ГИИС
-- недоступна, показываются последние загруженные значения с пометкой, что они
-- могли устареть, — настройки при этом остаются открытыми.
CREATE TABLE `dmdk_dictionary_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`extra_json` text DEFAULT '{}' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`fetched_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dmdk_dictionary_unique` ON `dmdk_dictionary_items` (`kind`,`external_id`);--> statement-breakpoint
-- Спецификация задания.
--
-- Черновик создаётся вместе с заданием, наполняется при закрытии сборки и
-- подписывается человеком в личном кабинете ГИИС. Состояние здесь — копия
-- состояния в ГИИС: сайт опрашивает его и по нему решает, можно ли вносить
-- УИН в сборочные задания площадки.
CREATE TABLE `dmdk_specifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer,
	`marketplace_id` text NOT NULL,
	`gis_id` text,
	`number` text NOT NULL,
	`state` text DEFAULT 'DS_SP_COMPLETE_SET' NOT NULL,
	`spec_date` text,
	`uin_count` integer DEFAULT 0 NOT NULL,
	`amount_kopecks` integer DEFAULT 0 NOT NULL,
	`vat_kopecks` integer DEFAULT 0 NOT NULL,
	`vat_rate` text,
	-- Спецификация собрана не из цен заказов, а из УПД, выгруженного из 1С.
	`from_upd` integer DEFAULT 0 NOT NULL,
	`upd_number` text,
	-- Спецификацию оформили руками в личном кабинете, минуя интеграцию.
	`manual` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`filled_at` text,
	`sent_at` text,
	`accepted_at` text,
	`checked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dmdk_specification_number_unique` ON `dmdk_specifications` (`number`);--> statement-breakpoint
CREATE INDEX `dmdk_specification_task_idx` ON `dmdk_specifications` (`task_id`);--> statement-breakpoint
CREATE INDEX `dmdk_specification_state_idx` ON `dmdk_specifications` (`state`,`created_at`);--> statement-breakpoint
-- Изделия в спецификации. Цена фиксируется в момент наполнения: заказ могут
-- отменить позже, но сумма подписанной спецификации меняться не должна.
CREATE TABLE `dmdk_specification_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`specification_id` integer NOT NULL,
	`uin` text NOT NULL,
	`article` text,
	`size` text,
	`external_order_id` text,
	`price_kopecks` integer DEFAULT 0 NOT NULL,
	`vat_kopecks` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dmdk_specification_item_unique` ON `dmdk_specification_items` (`specification_id`,`uin`);--> statement-breakpoint
-- Журнал обращений к сервису интеграции.
--
-- Сервис отвечает асинхронно: запрос возвращает messageId, а результат
-- забирается парным методом. Без журнала невозможно понять, что ушло, что
-- зависло и что нужно повторить.
CREATE TABLE `dmdk_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`method` text NOT NULL,
	`specification_id` integer,
	`message_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`signed` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `dmdk_request_status_idx` ON `dmdk_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `dmdk_request_spec_idx` ON `dmdk_requests` (`specification_id`);--> statement-breakpoint
-- Регистр из 1С: штрихкод бирки → УИН, артикул, размер.
--
-- По нему сборщик сканирует бирку, а сайт понимает, что именно взято, и ловит
-- пересорт до того, как изделие уедет. Пока загружается вручную файлом.
CREATE TABLE `dmdk_registry_items` (
	`barcode` text PRIMARY KEY NOT NULL,
	`uin` text NOT NULL,
	`article` text NOT NULL,
	`size` text,
	`upload_id` integer,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dmdk_registry_uin_idx` ON `dmdk_registry_items` (`uin`);--> statement-breakpoint
CREATE INDEX `dmdk_registry_article_idx` ON `dmdk_registry_items` (`article`,`size`);--> statement-breakpoint
CREATE TABLE `dmdk_registry_uploads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_name` text NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`accepted_count` integer DEFAULT 0 NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`uploaded_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
