-- Очередь позиций, у которых изменился резерв.
--
-- Раньше остатки уезжали на площадки только по часам: заказ, сделанный в 14:20
-- на Ozon, доходил до Wildberries в 15:10. Теперь пересчёт резервов помечает
-- здесь каждый артикул, у которого резерв изменился, а фоновая задача сразу
-- после загрузки заказов отправляет остаток только по этим артикулам.
CREATE TABLE `stock_dirty_skus` (
	`product_sku` text PRIMARY KEY NOT NULL,
	`reason` text,
	`marked_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stock_dirty_marked_at_idx` ON `stock_dirty_skus` (`marked_at`);
