import {
  encryptCredentialValues,
  revokedSettingKey,
  validateCredentialPayload,
} from "@/lib/credentials";
import type { MarketplaceId } from "@/lib/marketplaces";
import { authorizeApi } from "@/lib/app-auth";
import { getRuntimeEnv } from "@/lib/runtime-env";

const marketplaceNames: Record<MarketplaceId, string> = {
  wildberries: "Wildberries",
  ozon: "Ozon",
  yandex: "Яндекс Маркет",
};

function isMarketplaceId(value: unknown): value is MarketplaceId {
  return value === "wildberries" || value === "ozon" || value === "yandex";
}

export async function POST(request: Request) {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  if (!runtime.CREDENTIALS_MASTER_KEY) {
    return Response.json({ error: "Защищённое хранилище ключей ещё не настроено." }, { status: 503 });
  }

  try {
    const body = await request.json() as { marketplaceId?: unknown; credentials?: unknown };
    if (!isMarketplaceId(body.marketplaceId) || !body.credentials || typeof body.credentials !== "object") {
      return Response.json({ error: "Некорректные данные подключения." }, { status: 400 });
    }
    const values = validateCredentialPayload(body.marketplaceId, body.credentials as Record<string, unknown>);
    const encrypted = await encryptCredentialValues(runtime.CREDENTIALS_MASTER_KEY, values);

    await runtime.DB.batch([
      runtime.DB.prepare(
        `INSERT INTO marketplaces (id, name, enabled, connection_status)
         VALUES (?, ?, 0, 'awaiting_keys')
         ON CONFLICT(id) DO UPDATE SET connection_status = 'awaiting_keys'`,
      ).bind(body.marketplaceId, marketplaceNames[body.marketplaceId]),
      runtime.DB.prepare(
        `INSERT INTO marketplace_credentials (marketplace_id, encrypted_payload, iv, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(marketplace_id) DO UPDATE SET
           encrypted_payload = excluded.encrypted_payload,
           iv = excluded.iv,
           updated_at = CURRENT_TIMESTAMP`,
      ).bind(body.marketplaceId, encrypted.encryptedPayload, encrypted.iv),
      // Добавление ключа снимает флаг отзыва доступа.
      runtime.DB.prepare("DELETE FROM settings WHERE key = ?").bind(revokedSettingKey(body.marketplaceId)),
    ]);

    return Response.json({ ok: true, marketplaceId: body.marketplaceId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ключи не сохранены.";
    return Response.json({ error: message }, { status: 400 });
  }
}

/**
 * Удаление API-ключа (ТЗ, п. 11).
 *
 * Удаление НЕ трогает список складов, настройки «Выгружать остатки» и ничего
 * не отправляет на маркетплейс. Оно только лишает систему возможности делать
 * новые запросы: площадка переходит в статус «API-ключ не добавлен».
 */
export async function DELETE(request: Request) {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const url = new URL(request.url);
  const marketplaceId = url.searchParams.get("marketplaceId");
  if (!isMarketplaceId(marketplaceId)) {
    return Response.json({ error: "Некорректный маркетплейс." }, { status: 400 });
  }

  const job = await runtime.DB.prepare("SELECT value FROM settings WHERE key = 'stocks_full_sync_job'").first<{ value: string }>();
  if (job?.value) {
    return Response.json({ error: "Дождитесь завершения текущей синхронизации остатков." }, { status: 409 });
  }

  await runtime.DB.batch([
    runtime.DB.prepare("DELETE FROM marketplace_credentials WHERE marketplace_id = ?").bind(marketplaceId),
    runtime.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, '1', CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = CURRENT_TIMESTAMP`,
    ).bind(revokedSettingKey(marketplaceId)),
    runtime.DB.prepare(
      `UPDATE marketplaces SET enabled = 0, connection_status = 'awaiting_keys' WHERE id = ?`,
    ).bind(marketplaceId),
    runtime.DB.prepare(
      `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
       VALUES (?, 'outbound', 'warehouses', 'success', 0, ?)`,
    ).bind(marketplaceId, `API-ключ удалён. Список складов и настройки выгрузки сохранены, остатки не отправлялись.`),
  ]);

  return Response.json({
    ok: true,
    marketplaceId,
    note: "Список складов и настройки выгрузки сохранены. Остатки не отправлялись и не обнулялись.",
  });
}
