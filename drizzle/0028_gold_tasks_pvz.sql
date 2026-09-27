-- Золото и серебро собираются разными заданиями: для золота 1С выписывает
-- отдельную УПД, и одно задание — одна УПД. Золото — артикул с «-з» на конце.
ALTER TABLE `pick_tasks` ADD `metal` text NOT NULL DEFAULT 'silver';--> statement-breakpoint
-- Тип пункта отгрузки WB на момент оформления (pp — ПВЗ, sc — СЦ, sw — склад):
-- по нему видно, почему для поставки заводились или не заводились короба.
ALTER TABLE `supplies` ADD `dropoff_type` text;
