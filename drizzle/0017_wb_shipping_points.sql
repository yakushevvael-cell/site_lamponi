-- Пункты отгрузки Wildberries вместо складов приёмки.
--
-- WB развёл два разных справочника: старые «офисы» (/api/v3/offices) и новые
-- пункты отгрузки (/api/marketplace/v3/fbs/shipping-points). Передать поставку
-- в доставку можно только указав пункт отгрузки из второго справочника —
-- идентификаторы у них разные, и подставить офис вместо пункта нельзя.
--
-- Тип пункта важен: грузоместа (короба) WB требует только для поставок на ПВЗ.
ALTER TABLE `dropoff_points` ADD `office_type` text;
--> statement-breakpoint
ALTER TABLE `dropoff_points` ADD `city` text;
--> statement-breakpoint
ALTER TABLE `dropoff_points` ADD `cargo_types` text;
--> statement-breakpoint
-- Способ и дата отгрузки поставки: WB отклоняет закрытие поставки без них.
ALTER TABLE `supplies` ADD `shipping_type` text;
--> statement-breakpoint
ALTER TABLE `supplies` ADD `shipping_date` text;
