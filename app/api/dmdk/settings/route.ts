/**
 * Настройки передачи данных в ГИИС ДМДК.
 *
 * Читает и сохраняет общие реквизиты и настройки по каждой площадке. Правит их
 * только владелец: ошибка в грузополучателе или контракте останавливает
 * отгрузку целиком, а последствия видно не сразу.
 */
import { authorizeApi } from "@/lib/app-auth";
import {
  DMDK_MARKETPLACES,
  defaultMarketplaceSettings,
  loadDictionaries,
  loadGeneralSettings,
  loadMarketplaceSettings,
  missingSettings,
  saveGeneralSettings,
  type DmdkMarketplaceId,
} from "@/lib/dmdk";
import { getRuntimeEnv } from "@/lib/runtime-env";

export const dynamic = "force-dynamic";

function isMarketplaceId(value: unknown): value is DmdkMarketplaceId {
  return value === "wildberries" || value === "ozon";
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET() {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;

  const [general, marketplaces, dictionaries] = await Promise.all([
    loadGeneralSettings(),
    loadMarketplaceSettings(),
    loadDictionaries(),
  ]);

  return Response.json({
    general,
    dictionaries,
    marketplaces: marketplaces.map((settings) => ({
      ...settings,
      name: DMDK_MARKETPLACES.find((item) => item.id === settings.marketplaceId)?.name ?? settings.marketplaceId,
      missing: missingSettings(settings as unknown as Record<string, unknown>),
    })),
  });
}

export async function POST(request: Request) {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  let body: { general?: unknown; marketplace?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Некорректные данные." }, { status: 400 });
  }

  if (body.general && typeof body.general === "object") {
    const general = body.general as Record<string, unknown>;
    const serviceUrl = text(general.serviceUrl);
    // Адрес сервиса задаётся вручную, поэтому проверяем его здесь: опечатка в
    // схеме обернулась бы запросами в никуда с невнятной ошибкой сети.
    if (serviceUrl && !/^https:\/\/[^\s]+$/i.test(serviceUrl)) {
      return Response.json({ error: "Адрес сервиса интеграции должен начинаться с https://" }, { status: 400 });
    }
    const signerUrl = text(general.signerUrl);
    if (signerUrl && !/^https?:\/\/[^\s]+$/i.test(signerUrl)) {
      return Response.json({ error: "Адрес подписного модуля должен начинаться с http:// или https://" }, { status: 400 });
    }
    const ogrn = text(general.ogrn);
    if (ogrn && !/^\d{11,15}$/.test(ogrn)) {
      return Response.json({ error: "ОГРН — это 13 цифр для юрлица или 15 для ИП." }, { status: 400 });
    }
    await saveGeneralSettings({
      serviceUrl,
      ogrn,
      signerUrl,
      signingEnabled: Boolean(general.signingEnabled),
      testMode: general.testMode === undefined ? true : Boolean(general.testMode),
    });
  }

  if (body.marketplace && typeof body.marketplace === "object") {
    const input = body.marketplace as Record<string, unknown>;
    if (!isMarketplaceId(input.marketplaceId)) {
      return Response.json({ error: "Неизвестная площадка." }, { status: 400 });
    }
    const base = defaultMarketplaceSettings(input.marketplaceId);
    const values = {
      shipperOgrn: text(input.shipperOgrn),
      shipperName: text(input.shipperName),
      consigneeOgrn: text(input.consigneeOgrn),
      consigneeName: text(input.consigneeName),
      dealId: text(input.dealId),
      dealNumber: text(input.dealNumber),
      carrierOgrn: text(input.carrierOgrn),
      carrierName: text(input.carrierName),
      amountType: text(input.amountType) || base.amountType,
      currency: (text(input.currency) || base.currency).toUpperCase(),
      vatRate: text(input.vatRate) || base.vatRate,
      priceSource: text(input.priceSource) || base.priceSource,
      enabled: Boolean(input.enabled),
    };

    // Включить площадку можно только с полным набором реквизитов: иначе
    // спецификация уйдёт в ГИИС неполной и вернётся ошибкой в разгар смены.
    const missing = missingSettings(values as unknown as Record<string, unknown>);
    if (values.enabled && missing.length) {
      return Response.json(
        { error: `Не заполнено: ${missing.join(", ")}. Пока не заполнено, площадку включить нельзя.` },
        { status: 400 },
      );
    }

    await runtime.DB.prepare(
      `INSERT INTO dmdk_settings (
         marketplace_id, shipper_ogrn, shipper_name, consignee_ogrn, consignee_name,
         deal_id, deal_number, carrier_ogrn, carrier_name,
         amount_type, currency, vat_rate, price_source, enabled, updated_by, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(marketplace_id) DO UPDATE SET
         shipper_ogrn = excluded.shipper_ogrn,
         shipper_name = excluded.shipper_name,
         consignee_ogrn = excluded.consignee_ogrn,
         consignee_name = excluded.consignee_name,
         deal_id = excluded.deal_id,
         deal_number = excluded.deal_number,
         carrier_ogrn = excluded.carrier_ogrn,
         carrier_name = excluded.carrier_name,
         amount_type = excluded.amount_type,
         currency = excluded.currency,
         vat_rate = excluded.vat_rate,
         price_source = excluded.price_source,
         enabled = excluded.enabled,
         updated_by = excluded.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
    )
      .bind(
        input.marketplaceId,
        values.shipperOgrn,
        values.shipperName,
        values.consigneeOgrn,
        values.consigneeName,
        values.dealId,
        values.dealNumber,
        values.carrierOgrn,
        values.carrierName,
        values.amountType,
        values.currency,
        values.vatRate,
        values.priceSource,
        values.enabled ? 1 : 0,
        auth.user.email,
      )
      .run();
  }

  return Response.json({ ok: true });
}
