-- Одна строка задания — одно изделие.
--
-- Раньше товар отправления хранился одной строкой с количеством: «С-3027-2з,
-- 4 шт.». УИН у строки один, поэтому отправление из четырёх одинаковых серёг
-- считалось одиночным: стол не ждал четырёх сканов, в Ozon уходил один УИН, и
-- Ozon отвечал «в отправлении 4 изделий, а отсканировано 1». Теперь количество
-- делится на строки по одной штуке, а `unit_no` — номер штуки внутри товара
-- отправления (0, 1, 2…). Такое отправление собирается в ячейке, как
-- отправление из разных артикулов.
ALTER TABLE `pick_task_items` ADD `unit_no` integer NOT NULL DEFAULT 0;--> statement-breakpoint
DROP INDEX IF EXISTS `pick_task_item_posting_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `pick_task_item_posting_unique` ON `pick_task_items` (`marketplace_id`, `external_order_id`, `external_sku`, `unit_no`);--> statement-breakpoint
-- Какие строки делим: задание не закрыто и не отменено, а этикетки по
-- отправлению ещё нет или она с ошибкой. Готовые и уже переданные площадке
-- отправления не трогаем — по ним всё решено.
CREATE TEMP TABLE `_split_items` AS
SELECT ti.id, CAST(ti.quantity AS INTEGER) AS units
FROM `pick_task_items` ti
JOIN `pick_tasks` t ON t.id = ti.task_id
LEFT JOIN `shipment_labels` sl
  ON sl.marketplace_id = ti.marketplace_id AND sl.external_order_id = ti.external_order_id
WHERE ti.quantity > 1
  AND t.status NOT IN ('shipped', 'cancelled')
  AND (sl.id IS NULL OR sl.status = 'error');--> statement-breakpoint
INSERT INTO `pick_task_items`
  (task_id, marketplace_id, external_order_id, external_sku, product_sku, article, size, quantity,
   cell_code, cell_sort, status, ordered_at, shipment_deadline, resolved_by, resolved_at, unit_no, created_at)
WITH RECURSIVE n(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM n WHERE k < 199)
SELECT ti.task_id, ti.marketplace_id, ti.external_order_id, ti.external_sku, ti.product_sku, ti.article, ti.size, 1,
       ti.cell_code, ti.cell_sort, ti.status, ti.ordered_at, ti.shipment_deadline, ti.resolved_by, ti.resolved_at,
       n.k, ti.created_at
FROM `pick_task_items` ti
JOIN `_split_items` s ON s.id = ti.id
JOIN n ON n.k < s.units;--> statement-breakpoint
-- УИН, выданный строке заранее без скана, — догадка под одиночное
-- отправление. Для сборного он помешал бы: скан записал бы не то изделие.
UPDATE `pick_task_items`
SET quantity = 1, uin = CASE WHEN scanned_at IS NULL THEN NULL ELSE uin END
WHERE id IN (SELECT id FROM `_split_items`);--> statement-breakpoint
-- Ошибка «отсканировано 1 из 4» больше не про эти отправления: снимаем её,
-- стол заново дождётся всех сканов.
UPDATE `shipment_labels`
SET status = 'pending', error = NULL, note = NULL, exemplar_status = NULL
WHERE status = 'error'
  AND EXISTS (
    SELECT 1 FROM `pick_task_items` ti JOIN `_split_items` s ON s.id = ti.id
    WHERE ti.marketplace_id = shipment_labels.marketplace_id
      AND ti.external_order_id = shipment_labels.external_order_id
  );--> statement-breakpoint
UPDATE `pick_tasks`
SET item_count = (SELECT COUNT(*) FROM `pick_task_items` ti WHERE ti.task_id = pick_tasks.id),
    picked_count = (SELECT COUNT(*) FROM `pick_task_items` ti WHERE ti.task_id = pick_tasks.id AND ti.status = 'picked'),
    not_found_count = (SELECT COUNT(*) FROM `pick_task_items` ti WHERE ti.task_id = pick_tasks.id AND ti.status = 'not_found')
WHERE id IN (SELECT DISTINCT task_id FROM `pick_task_items` WHERE id IN (SELECT id FROM `_split_items`));--> statement-breakpoint
DROP TABLE `_split_items`;
