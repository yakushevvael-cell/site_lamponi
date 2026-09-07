import { getRuntimeEnv } from "@/lib/runtime-env";
import { authorizeApi } from "@/lib/app-auth";

export async function GET(request: Request) {
  const auth = await authorizeApi();
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна.", stocks: [] }, { status: 500 });

  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 500), 1), 5000);
  const statement = runtime.DB.prepare(
    `SELECT
       p.source_sku AS variantKey,
       p.article AS sku,
       p.size AS size,
       p.current_physical_qty AS physicalQuantity,
       COALESCE(SUM(CASE WHEN r.status = 'active' THEN r.quantity ELSE 0 END), 0) AS reservedQuantity,
       p.safety_stock AS safetyStock,
       p.manual_zero AS manualZero,
       p.manual_zero_at AS manualZeroAt,
       -- Та же формула, что и в lib/stock-math: MAX(0; ОСВ − резерв − страховой), целое.
       CASE WHEN p.manual_zero = 1 THEN 0 ELSE MAX(0, CAST(p.current_physical_qty - COALESCE(SUM(CASE WHEN r.status = 'active' THEN r.quantity ELSE 0 END), 0) - p.safety_stock AS INTEGER)) END AS availableQuantity,
       p.updated_at AS updatedAt
     FROM products p
     LEFT JOIN stock_reservations r ON r.product_sku = p.source_sku
     WHERE p.article <> ''
       AND (? = '' OR p.article LIKE '%' || ? || '%' OR COALESCE(p.size, '') LIKE '%' || ? || '%')
     GROUP BY p.source_sku, p.article, p.size
     ORDER BY p.article ASC, p.size ASC
     LIMIT ?`,
  ).bind(query, query, query, limit);

  const { results } = await statement.all();
  const totals = await runtime.DB.prepare(
    `SELECT
      COUNT(*) AS skuCount,
      COUNT(DISTINCT p.article) AS articleCount,
      SUM(CASE WHEN p.size IS NOT NULL THEN 1 ELSE 0 END) AS sizedVariantCount,
      COALESCE(SUM(p.current_physical_qty), 0) AS physicalQuantity,
      SUM(CASE WHEN p.manual_zero = 1 OR p.current_physical_qty = 0 THEN 1 ELSE 0 END) AS zeroStockCount,
      SUM(CASE WHEN p.manual_zero = 1 THEN 1 ELSE 0 END) AS manualZeroCount,
      COALESCE((SELECT SUM(quantity) FROM stock_reservations WHERE status = 'active'), 0) AS reservedQuantity,
      COALESCE(SUM(p.safety_stock), 0) AS safetyStock,
      COALESCE(SUM(CASE WHEN p.manual_zero = 1 THEN 0 ELSE MAX(0, CAST(
        p.current_physical_qty
        - COALESCE((SELECT SUM(quantity) FROM stock_reservations r WHERE r.status = 'active' AND r.product_sku = p.source_sku), 0)
        - p.safety_stock
      AS INTEGER)) END), 0) AS availableQuantity
     FROM products p
     WHERE p.article <> ''`,
  ).first();

  return Response.json({ stocks: results, totals: totals ?? { skuCount: 0, physicalQuantity: 0, zeroStockCount: 0 } });
}
