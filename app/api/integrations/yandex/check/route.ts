/**
 * Проверка подключения Яндекс Маркета.
 *
 * Складов в привычном смысле на DBS нет: товар лежит у нас, а доставку
 * организует продавец. Поэтому вместо списка складов площадки заводится один
 * склад-магазин — по нему группируются задания на сборку так же, как по
 * региональным складам Wildberries.
 */
import { getMarketplaceCredentials, deliveryConfigured } from "@/lib/credentials";
import { authorizeApi } from "@/lib/app-auth";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { getYandexCampaigns, YandexApiError } from "@/lib/yandex";

const MARKETPLACE_ID = "yandex";
const MARKETPLACE_NAME = "Яндекс Маркет";

async function recordFailure(db: D1Database, message: string) {
  await db.batch([
    db.prepare(
      `INSERT INTO marketplaces (id, name, enabled, connection_status)
       VALUES (?, ?, 0, 'error')
       ON CONFLICT(id) DO UPDATE SET connection_status = 'error'`,
    ).bind(MARKETPLACE_ID, MARKETPLACE_NAME),
    db.prepare(
      `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
       VALUES (?, 'inbound', 'warehouses', 'error', 0, ?)`,
    ).bind(MARKETPLACE_ID, message.slice(0, 500)),
  ]);
}

export async function POST() {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const credentials = await getMarketplaceCredentials(runtime.DB, runtime, MARKETPLACE_ID);
  const apiKey = credentials.YANDEX_API_KEY;
  const campaignId = credentials.YANDEX_CAMPAIGN_ID;
  if (!apiKey || !campaignId) {
    return Response.json({ error: "Добавьте Api-Key и номер магазина Яндекс Маркета." }, { status: 400 });
  }

  try {
    const campaigns = await getYandexCampaigns(apiKey);
    const campaign = campaigns.find((row) => String(row.id) === String(campaignId).trim());
    if (!campaign) {
      const known = campaigns.map((row) => row.id).join(", ") || "ни одного";
      throw new YandexApiError(
        422,
        `Магазин ${campaignId} этому Api-Key недоступен. Ключ видит магазины: ${known}.`,
      );
    }

    // businessId в ключах должен совпадать с кабинетом магазина: иначе каталог
    // читается из чужого кабинета и сопоставление артикулов молча развалится.
    const businessId = String(credentials.YANDEX_BUSINESS_ID ?? "").trim();
    const remoteBusinessId = campaign.businessId === null ? "" : String(campaign.businessId);
    if (businessId && remoteBusinessId && businessId !== remoteBusinessId) {
      throw new YandexApiError(
        422,
        `Номер кабинета не совпадает: в ключах ${businessId}, у магазина ${remoteBusinessId}.`,
      );
    }

    const checkedAt = new Date().toISOString();
    const warehouseName = campaign.domain ? `Яндекс Маркет · ${campaign.domain}` : "Яндекс Маркет · DBS";

    await runtime.DB.batch([
      runtime.DB.prepare(
        `INSERT INTO marketplaces (id, name, enabled, connection_status, last_sync_at)
         VALUES (?, ?, 1, 'connected', ?)
         ON CONFLICT(id) DO UPDATE SET enabled = 1, connection_status = 'connected', last_sync_at = excluded.last_sync_at`,
      ).bind(MARKETPLACE_ID, MARKETPLACE_NAME, checkedAt),
      runtime.DB.prepare(
        `INSERT INTO marketplace_warehouses
           (marketplace_id, external_id, name, remote_active, remote_status, publish_full_stock, last_checked_at)
         VALUES (?, ?, ?, 1, ?, 0, ?)
         ON CONFLICT(marketplace_id, external_id) DO UPDATE SET
           name = excluded.name,
           remote_active = 1,
           remote_status = excluded.remote_status,
           last_checked_at = excluded.last_checked_at`,
      ).bind(MARKETPLACE_ID, String(campaign.id), warehouseName, campaign.placementType ?? "DBS", checkedAt),
      runtime.DB.prepare(
        `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
         VALUES (?, 'inbound', 'warehouses', 'success', 1, ?)`,
      ).bind(MARKETPLACE_ID, `Магазин ${campaign.id} подтверждён, модель ${campaign.placementType ?? "DBS"}`),
    ]);

    return Response.json({
      ok: true,
      checkedAt,
      warehouseCount: 1,
      activeWarehouseCount: 1,
      campaignId: campaign.id,
      businessId: campaign.businessId,
      placementType: campaign.placementType,
      // Курьер вызывается отдельными ключами: без них заказы соберутся, но не уедут.
      deliveryConfigured: deliveryConfigured(credentials),
      warehouses: [{ id: String(campaign.id), name: warehouseName, type: campaign.placementType ?? "DBS", active: true }],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось проверить Яндекс Маркет.";
    await recordFailure(runtime.DB, message).catch(() => undefined);
    const status = error instanceof YandexApiError && error.status < 500 ? error.status : 502;
    return Response.json({ error: message }, { status });
  }
}
