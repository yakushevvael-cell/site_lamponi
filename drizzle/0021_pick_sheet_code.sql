-- Уникальный штрихкод листа подбора и ручное закрытие отгрузки.
--
-- Штрихкод раньше складывался из номера задания в базе («T18»): он был
-- предсказуемым и повторялся при каждой перепечатке. Теперь у задания свой
-- код из 12 цифр, он никогда не повторяется — по нему стол сканирования и
-- поставки узнают задание, и только он открывает работу с заданием.
--
-- Старым заданиям код выдаётся по номеру в базе и начинается с 9: так он
-- заведомо не столкнётся с новыми, которые начинаются с 1–8.
ALTER TABLE `pick_tasks` ADD `barcode` text;--> statement-breakpoint
UPDATE `pick_tasks` SET `barcode` = '9' || substr('00000000000' || `id`, -11) WHERE `barcode` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `pick_task_barcode_unique` ON `pick_tasks` (`barcode`);--> statement-breakpoint
-- Часть поставок оформляли руками в кабинете площадки, а на сайте они висели
-- неотгруженными. Отметка хранится отдельно от обычного закрытия: видно, что
-- задание закрыто человеком, а не площадкой.
ALTER TABLE `pick_tasks` ADD `manual_close_at` text;--> statement-breakpoint
ALTER TABLE `pick_tasks` ADD `manual_close_by` text;--> statement-breakpoint
ALTER TABLE `pick_tasks` ADD `manual_close_note` text;--> statement-breakpoint
ALTER TABLE `supplies` ADD `closed_manually` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `supplies` ADD `closed_by` text;
