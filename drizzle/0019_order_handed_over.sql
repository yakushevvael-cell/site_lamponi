-- Когда заказ FBS передан площадке — перешёл на этап «доставляется».
--
-- shipped_at для этого не годится: у Ozon в него пишется плановая дата отгрузки
-- (дедлайн), а статус awaiting_deliver — «упаковано, ждёт передачи» — уже
-- считался отгрузкой. На shipped_at держится закрытие резервов, поэтому его
-- смысл не меняем, а заводим отдельное поле.
ALTER TABLE `orders` ADD `handed_over_at` text;
--> statement-breakpoint
CREATE INDEX `order_handed_over_idx` ON `orders` (`handed_over_at`);
--> statement-breakpoint
-- Wildberries: shipped_at ставился в момент, когда синхронизация впервые
-- увидела задание в доставке, — это и есть время передачи.
UPDATE `orders` SET `handed_over_at` = `shipped_at`
WHERE `marketplace_id` = 'wildberries' AND `shipped_at` IS NOT NULL AND `canceled_at` IS NULL
  AND (`status` LIKE 'complete/%' OR `status` LIKE '%/sorted' OR `status` LIKE '%/sold'
       OR `status` LIKE '%/ready_for_pickup' OR `status` LIKE '%/postponed_delivery');
--> statement-breakpoint
-- Ozon: до ближайшей синхронизации — дата отгрузки по плану. Синхронизация
-- заменит её точной датой начала доставки (delivering_date) за последние 30 дней.
UPDATE `orders` SET `handed_over_at` = `shipped_at`
WHERE `marketplace_id` = 'ozon' AND `shipped_at` IS NOT NULL
  AND `status` NOT IN ('awaiting_registration', 'acceptance_in_progress', 'awaiting_approve',
                       'awaiting_verification', 'awaiting_packaging', 'awaiting_deliver',
                       'cancelled', 'canceled', 'unknown');
