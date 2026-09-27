-- УПД загружается к заданию: одна УПД — одно задание.
--
-- Раньше УИН из всех загруженных УПД лежали общей кучей «свободных», и под
-- отправление брался первый свободный УИН того же артикула — в том числе из
-- старых УПД. Когда один артикул ехал двум покупателям, отсканированный УИН
-- расходился с переданным на площадку.
--
-- Теперь УПД сверяется с заданием по «артикул + размер», и только при полном
-- совпадении каждый УИН закрепляется за своим изделием и уходит на площадку.
-- Свободных УИН в базе нет: после закрытия поставки или отмены задания УИН
-- задания удаляются.
ALTER TABLE `upd_uploads` ADD `task_id` integer;--> statement-breakpoint
ALTER TABLE `upd_uploads` ADD `status` text;--> statement-breakpoint
ALTER TABLE `upd_uploads` ADD `problems_json` text;--> statement-breakpoint
ALTER TABLE `uin_items` ADD `task_id` integer;--> statement-breakpoint
CREATE INDEX `uin_item_task_idx` ON `uin_items` (`task_id`);--> statement-breakpoint
-- Отметка, что УПД задания сверена и УИН закреплены. Без неё упаковка по
-- заданию заблокирована.
ALTER TABLE `pick_tasks` ADD `upd_matched_at` text;--> statement-breakpoint
ALTER TABLE `pick_tasks` ADD `upd_upload_id` integer;--> statement-breakpoint
-- Догадки прежней раздачи снимаем: у изделия, которое не отсканировано и чей
-- УИН площадке не передан, УИН был взят «первый свободный». Его заменит УИН из
-- УПД задания.
UPDATE `pick_task_items`
SET `uin` = NULL
WHERE `uin` IS NOT NULL
  AND `scanned_at` IS NULL
  AND `task_id` IN (SELECT `id` FROM `pick_tasks` WHERE `status` NOT IN ('shipped', 'cancelled'))
  AND NOT EXISTS (
    SELECT 1 FROM `shipment_labels` sl
    WHERE sl.marketplace_id = `pick_task_items`.marketplace_id
      AND sl.external_order_id = `pick_task_items`.external_order_id
      AND (sl.status = 'ready' OR (sl.status = 'pending' AND sl.note IS NOT NULL) OR sl.ship_postings IS NOT NULL)
  );--> statement-breakpoint
-- Все ранее загруженные УИН удаляются: УПД открытых заданий загружают заново.
DELETE FROM `uin_items`;
