/**
 * Общий выключатель выгрузки остатков.
 *
 * Нужен как «стоп-кран»: когда с расчётом или с площадкой что-то не так,
 * отправку надо прекратить немедленно и без потерь — не удаляя API-ключи,
 * не отключая склады и не трогая сопоставления товаров. Одна запись в
 * settings, которую проверяют ВСЕ маршруты, что-либо отправляющие на
 * маркетплейсы: полная и выборочная синхронизация, ручное обнуление,
 * включение выгрузки на складе и пробные отправки.
 *
 * Загрузку заказов выключатель НЕ трогает: она только читает данные с
 * площадок и держит резервы в актуальном состоянии, ничего не меняя у
 * продавца. После снятия паузы первая же выгрузка уйдёт с правильными
 * числами, а не с устаревшими.
 */

export const STOCK_SYNC_PAUSE_KEY = "stock_sync_paused";

export type StockSyncPause = {
  paused: boolean;
  changedAt: string | null;
  changedBy: string | null;
  reason: string | null;
};

const NOT_PAUSED: StockSyncPause = { paused: false, changedAt: null, changedBy: null, reason: null };

export async function readStockSyncPause(db: D1Database): Promise<StockSyncPause> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(STOCK_SYNC_PAUSE_KEY).first<{ value: string }>();
  if (!row?.value) return NOT_PAUSED;
  try {
    const parsed = JSON.parse(row.value) as Partial<StockSyncPause>;
    return {
      paused: parsed.paused === true,
      changedAt: typeof parsed.changedAt === "string" ? parsed.changedAt : null,
      changedBy: typeof parsed.changedBy === "string" ? parsed.changedBy : null,
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
    };
  } catch {
    // Повреждённое значение трактуем как «пауза включена»: безопаснее
    // не отправить остатки, чем отправить их вопреки запрету.
    return { ...NOT_PAUSED, paused: true, reason: "Настройка повреждена — выгрузка остановлена до перенастройки." };
  }
}

export async function setStockSyncPause(
  db: D1Database,
  paused: boolean,
  actorEmail: string,
  reason?: string | null,
): Promise<StockSyncPause> {
  const state: StockSyncPause = {
    paused,
    changedAt: new Date().toISOString(),
    changedBy: actorEmail,
    reason: reason ? String(reason).slice(0, 300) : null,
  };
  await db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).bind(STOCK_SYNC_PAUSE_KEY, JSON.stringify(state)).run();
  await db.prepare(
    `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
     VALUES ('wildberries', 'outbound', 'stocks', 'success', 0, ?)`,
  ).bind(paused ? `Выгрузка остатков остановлена: ${actorEmail}` : `Выгрузка остатков возобновлена: ${actorEmail}`).run();
  return state;
}

/**
 * Возвращает готовый ответ, если выгрузка остановлена, и null, если разрешена.
 * Вызывается в начале каждого маршрута, который что-то отправляет на площадку.
 */
export async function stockSyncBlocked(db: D1Database): Promise<Response | null> {
  const state = await readStockSyncPause(db);
  if (!state.paused) return null;
  const who = state.changedBy ? ` Остановил: ${state.changedBy}.` : "";
  return Response.json({
    error: `Выгрузка остатков на площадки остановлена.${who} Снимите паузу на вкладке «Остатки», чтобы возобновить отправку.`,
    stockSyncPaused: true,
    pause: state,
  }, { status: 423 });
}
