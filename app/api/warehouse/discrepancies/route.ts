/**
 * Вкладка «Расхождения» (ТЗ, п. 4) — уровень начальника склада.
 *
 * Показывает, где учёт и склад разошлись: артикул, количество по 1С, дата
 * блокировки, кто заблокировал, сколько заказов сорвалось. Строки, где
 * количество в ОСВ выросло после блокировки, подсвечиваются — это подсказка,
 * куда смотреть первым делом, а не команда снимать блокировку.
 */
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { OSV_UNITS_SQL } from "@/lib/osv-units";

export async function GET() {
  const auth = await authorizePermission(["warehouse.problems.release", "warehouse.reports"]);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  // Количество по 1С берётся по тому же правилу, что и выгрузка остатков:
  // серьги в 1С считаются штуками, а на площадке парами.
  const rows = await db.prepare(
    `SELECT pa.id,
            pa.article,
            pa.size,
            pa.state,
            pa.status,
            pa.osv_qty_at_block AS osvQtyAtBlock,
            pa.failed_order_count AS failedOrderCount,
            pa.task_number AS taskNumber,
            pa.marketplace_id AS marketplaceId,
            pa.external_order_id AS externalOrderId,
            pa.shipment_deadline AS shipmentDeadline,
            pa.blocked_by AS blockedBy,
            pa.blocked_at AS blockedAt,
            pa.released_by AS releasedBy,
            pa.released_at AS releasedAt,
            pa.cancelled_on_marketplace_at AS cancelledOnMarketplaceAt,
            pa.comment,
            (SELECT COALESCE(SUM(${OSV_UNITS_SQL}), 0)
               FROM products p
              WHERE p.article = pa.article
                AND (pa.size IS NULL OR p.size = pa.size OR p.size IS NULL)) AS osvQtyNow,
            (SELECT COUNT(*)
               FROM products p
              WHERE p.article = pa.article
                AND (pa.size IS NULL OR p.size = pa.size OR p.size IS NULL)
                AND p.manual_zero = 1) AS zeroedSkuCount
     FROM problem_articles pa
     ORDER BY CASE pa.state WHEN 'blocked' THEN 0 ELSE 1 END, pa.blocked_at DESC
     LIMIT 300`,
  ).all<{ article: string; osvQtyAtBlock: number; osvQtyNow: number }>();

  const lastOsv = await db.prepare(
    `SELECT id, file_name AS fileName, balance_date AS balanceDate, created_at AS createdAt
     FROM osv_uploads WHERE status = 'processed' ORDER BY id DESC LIMIT 1`,
  ).first<{ id: number; fileName: string; balanceDate: string | null; createdAt: string }>();

  const log = await db.prepare(
    `SELECT id, article, size, action, actor_email AS actorEmail, comment,
            task_number AS taskNumber, created_at AS createdAt
     FROM problem_article_log ORDER BY created_at DESC, id DESC LIMIT 200`,
  ).all();

  const items = rows.results.map((row) => ({
    ...row,
    // Рост количества в ОСВ после блокировки — сигнал «посмотри сюда»,
    // а не признак, что товар нашёлся: в ОСВ мог прийти новый выпуск.
    osvGrew: Number(row.osvQtyNow ?? 0) > Number(row.osvQtyAtBlock ?? 0),
  }));

  return Response.json({
    items,
    log: log.results,
    lastOsv,
    canRelease: auth.permissions.includes("warehouse.problems.release"),
  });
}
