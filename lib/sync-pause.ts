/**
 * Режим выгрузки остатков — один переключатель на весь сервис.
 *
 * Раньше здесь был двоичный стоп-кран: выгрузка либо идёт целиком, либо не идёт
 * совсем. В жизни этого не хватило. Остатки на складе часто выставлены руками —
 * их нельзя перезаписывать целиком, но по отдельным артикулам отправлять нужно.
 * Приходилось снимать паузу, быстро отправить выбранное и успеть поставить её
 * обратно, пока не сработал часовой таймер. Уследить за этим нельзя.
 *
 * Поэтому режимов три, и они описывают не кнопки, а происходящее:
 *
 *   auto    — сервис ведёт остатки сам: полная выгрузка раз в час и доотправка
 *             изменившихся каждые 15 минут;
 *   manual  — площадки сервис сам не трогает. Уходит только то, что человек
 *             отметил галочками и отправил кнопкой. Автоматика молчит;
 *   stopped — не уходит ничего, ни автоматически, ни вручную.
 *
 * Загрузку заказов режим не трогает ни в каком положении: она только читает
 * данные с площадок и держит резервы в актуальном состоянии.
 *
 * Проверку делают ВСЕ маршруты, что-либо отправляющие на маркетплейсы:
 * `stockSyncBlocked` — там, где любая отправка недопустима, а
 * `bulkStockSyncBlocked` — там, где на площадку уходит весь ассортимент.
 */

/** Старый двоичный ключ: читаем, чтобы уже включённая пауза не потерялась. */
export const STOCK_SYNC_PAUSE_KEY = "stock_sync_paused";
export const STOCK_SYNC_MODE_KEY = "stock_sync_mode";

export type StockSyncMode = "auto" | "manual" | "stopped";

export type StockSyncState = {
  mode: StockSyncMode;
  /** «Остановлено» — это прежняя пауза. Поле оставлено для интерфейса и старого кода. */
  paused: boolean;
  changedAt: string | null;
  changedBy: string | null;
  reason: string | null;
};

const DEFAULT_STATE: StockSyncState = {
  mode: "auto",
  paused: false,
  changedAt: null,
  changedBy: null,
  reason: null,
};

function isMode(value: unknown): value is StockSyncMode {
  return value === "auto" || value === "manual" || value === "stopped";
}

function stateOf(mode: StockSyncMode, rest: Partial<StockSyncState>): StockSyncState {
  return {
    mode,
    paused: mode === "stopped",
    changedAt: typeof rest.changedAt === "string" ? rest.changedAt : null,
    changedBy: typeof rest.changedBy === "string" ? rest.changedBy : null,
    reason: typeof rest.reason === "string" ? rest.reason : null,
  };
}

export async function readStockSyncState(db: D1Database): Promise<StockSyncState> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(STOCK_SYNC_MODE_KEY).first<{ value: string }>();
  if (row?.value) {
    try {
      const parsed = JSON.parse(row.value) as Partial<StockSyncState>;
      if (isMode(parsed.mode)) return stateOf(parsed.mode, parsed);
    } catch {
      // Повреждённое значение трактуем как «Остановлено»: безопаснее не
      // отправить остатки, чем отправить их вопреки запрету.
      return stateOf("stopped", { reason: "Настройка повреждена — выгрузка остановлена до перенастройки." });
    }
  }

  // Ключа режима ещё нет: смотрим старую паузу, чтобы при обновлении сервиса
  // включённый стоп-кран не превратился молча в рабочий режим.
  const legacy = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(STOCK_SYNC_PAUSE_KEY).first<{ value: string }>();
  if (!legacy?.value) return DEFAULT_STATE;
  try {
    const parsed = JSON.parse(legacy.value) as Partial<StockSyncState> & { paused?: boolean };
    return stateOf(parsed.paused === true ? "stopped" : "auto", parsed);
  } catch {
    return stateOf("stopped", { reason: "Настройка повреждена — выгрузка остановлена до перенастройки." });
  }
}

/** @deprecated читайте режим: `readStockSyncState`. Оставлено для старых вызовов. */
export const readStockSyncPause = readStockSyncState;
export type StockSyncPause = StockSyncState;

export async function setStockSyncMode(
  db: D1Database,
  mode: StockSyncMode,
  actorEmail: string,
  reason?: string | null,
): Promise<StockSyncState> {
  const state: StockSyncState = {
    mode,
    paused: mode === "stopped",
    changedAt: new Date().toISOString(),
    changedBy: actorEmail,
    reason: reason ? String(reason).slice(0, 300) : null,
  };
  await db.batch([
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    ).bind(STOCK_SYNC_MODE_KEY, JSON.stringify(state)),
    // Старый ключ держим согласованным: на него смотрят прошлые версии кода,
    // если сервер откатится на предыдущий коммит.
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    ).bind(STOCK_SYNC_PAUSE_KEY, JSON.stringify({ ...state, paused: mode === "stopped" })),
  ]);
  await db.prepare(
    `INSERT INTO sync_events (marketplace_id, direction, kind, status, item_count, message)
     VALUES (NULL, 'outbound', 'stocks', 'success', 0, ?)`,
  ).bind(`Режим выгрузки остатков: ${MODE_TITLE[mode]} (${actorEmail})`).run().catch(() => undefined);
  return state;
}

export const MODE_TITLE: Record<StockSyncMode, string> = {
  auto: "автоматический",
  manual: "ручной",
  stopped: "остановлено",
};

function blockedResponse(state: StockSyncState, message: string) {
  const who = state.changedBy ? ` Установил: ${state.changedBy}.` : "";
  return Response.json({
    error: `${message}${who}`,
    stockSyncPaused: true,
    stockSyncMode: state.mode,
    pause: state,
  }, { status: 423 });
}

/**
 * Полный запрет отправки — режим «Остановлено».
 * Возвращает готовый ответ, если отправлять нельзя, и null, если можно.
 */
export async function stockSyncBlocked(db: D1Database): Promise<Response | null> {
  const state = await readStockSyncState(db);
  if (state.mode !== "stopped") return null;
  return blockedResponse(state, "Выгрузка остатков на площадки остановлена.");
}

/**
 * Запрет массовой выгрузки — режимы «Остановлено» и «Ручной».
 *
 * Сюда попадает всё, что отправляет на площадку весь сопоставленный
 * ассортимент: полная синхронизация (и по кнопке, и по часовому таймеру),
 * доотправка из очереди и включение склада с выгрузкой остатка.
 */
export async function bulkStockSyncBlocked(db: D1Database): Promise<Response | null> {
  const state = await readStockSyncState(db);
  if (state.mode === "auto") return null;
  if (state.mode === "stopped") return blockedResponse(state, "Выгрузка остатков на площадки остановлена.");
  return blockedResponse(
    state,
    "Включён ручной режим: сервис не отправляет остатки по всему ассортименту. "
    + "Отметьте нужные позиции и отправьте их кнопкой «Синхронизировать выбранные».",
  );
}
