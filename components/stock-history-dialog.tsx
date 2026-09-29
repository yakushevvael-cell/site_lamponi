"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Radar,
  RefreshCw,
  ShoppingCart,
  XCircle,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * «История» позиции на странице «Остатки».
 *
 * Лента по времени: заказ (площадка, склад) → корректировка остатка на всех
 * складах площадок одной строкой «успешно / ошибка» с раскрытием по складам →
 * проверка площадок через 10 минут: что фактически лежит на каждом складе.
 * Данные собирает /api/stocks/history, правила — lib/stock-history-core.mjs.
 */

type MarketplaceId = "wildberries" | "ozon" | "yandex";

type CorrectionWarehouse = {
  marketplaceId: MarketplaceId;
  warehouseId: string;
  warehouseName: string;
  status: "success" | "error" | "blocked" | "skipped" | "disabled" | "not_sent" | "unsupported";
  sentQty: number | null;
  message: string | null;
};

type CheckRow = {
  marketplaceId: MarketplaceId;
  warehouseId: string;
  warehouseName: string | null;
  publishing: boolean;
  status: "ok" | "missing" | "error";
  amount: number | null;
  reserved: number | null;
  expectedQty: number | null;
  message: string | null;
  mismatch: boolean;
};

type OrderEvent = {
  type: "order" | "cancel";
  id: string;
  at: string;
  marketplaceId: MarketplaceId;
  externalOrderId: string;
  warehouseName: string | null;
  quantity: number;
  source?: string | null;
};

type CorrectionEvent = {
  type: "correction";
  id: string;
  at: string;
  until: string | null;
  count: number;
  kind: string;
  label: string;
  actorEmail: string | null;
  ok: boolean;
  title: string;
  succeeded: number;
  failed: number;
  skipped: number;
  disabled: number;
  warehouses: CorrectionWarehouse[];
};

type CheckEvent = {
  type: "check";
  id: string;
  at: string;
  trigger: string;
  status: "done" | "error";
  message: string | null;
  mismatches: number;
  errors: number;
  rows: CheckRow[];
};

type PendingCheckEvent = { type: "check_pending"; id: string; at: string; trigger: string };

type HistoryEvent = OrderEvent | CorrectionEvent | CheckEvent | PendingCheckEvent;

type HistoryResponse = {
  product: { sourceSku: string; article: string | null; size: string | null };
  marketplaces: MarketplaceId[];
  days: number;
  events: HistoryEvent[];
  error?: string;
};

const PERIODS = [1, 7, 30, 60] as const;

const marketplaceName: Record<MarketplaceId, string> = {
  wildberries: "Wildberries",
  ozon: "Ozon",
  yandex: "Яндекс Маркет",
};

const marketplaceBadge: Record<MarketplaceId, string> = {
  wildberries: "bg-violet-100 text-violet-900 hover:bg-violet-100",
  ozon: "bg-blue-100 text-blue-900 hover:bg-blue-100",
  yandex: "bg-amber-100 text-amber-900 hover:bg-amber-100",
};

const correctionStatus: Record<CorrectionWarehouse["status"], { label: string; className: string }> = {
  success: { label: "успешно", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  error: { label: "ошибка", className: "border-rose-200 bg-rose-50 text-rose-700" },
  blocked: { label: "заблокировано проверкой", className: "border-amber-200 bg-amber-50 text-amber-800" },
  skipped: { label: "пропущено", className: "border-slate-200 bg-slate-50 text-slate-700" },
  disabled: { label: "склад отключён", className: "border-dashed text-muted-foreground" },
  not_sent: { label: "не отправлялось", className: "border-dashed text-muted-foreground" },
  unsupported: { label: "выгрузка на Маркет не ведётся", className: "border-dashed text-muted-foreground" },
};

const cancelSource: Record<string, string> = {
  customer: "покупателем",
  seller: "продавцом",
  marketplace: "площадкой",
};

function time(value: string) {
  return new Date(value).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function dayKey(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayTitle(value: string) {
  return new Date(value).toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "long", year: "numeric" });
}

function qty(value: number | null) {
  return value === null ? "—" : Number(value).toLocaleString("ru-RU");
}

function MarketplaceBadge({ id }: { id: MarketplaceId }) {
  return <Badge className={marketplaceBadge[id] ?? ""}>{marketplaceName[id] ?? id}</Badge>;
}

function EventTime({ at }: { at: string }) {
  return <span className="w-12 shrink-0 pt-0.5 font-mono text-xs tabular-nums text-muted-foreground">{time(at)}</span>;
}

function OrderLine({ event }: { event: OrderEvent }) {
  const cancel = event.type === "cancel";
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <EventTime at={event.at} />
      {cancel
        ? <XCircle className="mt-0.5 size-4 shrink-0 text-rose-500" />
        : <ShoppingCart className="mt-0.5 size-4 shrink-0 text-sky-600" />}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="font-medium">
          {cancel ? `Отмена заказа${event.source && cancelSource[event.source] ? ` ${cancelSource[event.source]}` : ""}` : "Заказ"}
        </span>
        <MarketplaceBadge id={event.marketplaceId} />
        <span className="text-muted-foreground">склад: {event.warehouseName ?? "не указан"}</span>
        <span className="text-xs text-muted-foreground">
          № {event.externalOrderId} · {event.quantity.toLocaleString("ru-RU")} шт.
        </span>
      </div>
    </div>
  );
}

function groupByMarketplace<T extends { marketplaceId: MarketplaceId }>(rows: T[]) {
  const groups = new Map<MarketplaceId, T[]>();
  for (const row of rows) {
    const list = groups.get(row.marketplaceId) ?? [];
    list.push(row);
    groups.set(row.marketplaceId, list);
  }
  return [...groups.entries()];
}

function CorrectionLine({ event, open, onToggle }: { event: CorrectionEvent; open: boolean; onToggle: () => void }) {
  const counts = [
    event.succeeded ? `успешно: ${event.succeeded}` : null,
    event.failed ? `с ошибкой: ${event.failed}` : null,
    event.skipped ? `пропущено: ${event.skipped}` : null,
    event.disabled ? `отключено: ${event.disabled}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <div>
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-muted/50">
        <EventTime at={event.at} />
        {event.ok
          ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
          : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-600" />}
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-medium ${event.ok ? "text-emerald-800" : "text-rose-700"}`}>{event.title}</p>
          <p className="text-xs text-muted-foreground">
            {event.label}
            {event.count > 1 && event.until ? ` · ×${event.count}, с ${time(event.at)} по ${time(event.until)}` : ""}
            {counts ? ` · складов ${counts}` : ""}
          </p>
        </div>
        {open ? <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
      </button>
      {open ? (
        <div className="space-y-2 px-4 pb-3 pl-[5.25rem]">
          {event.warehouses.length === 0 ? (
            <p className="text-xs text-muted-foreground">Нет данных по складам.</p>
          ) : groupByMarketplace(event.warehouses).map(([marketplaceId, rows]) => (
            <div key={marketplaceId} className="rounded-lg border">
              <p className="border-b bg-muted/40 px-3 py-1.5 text-xs font-semibold">{marketplaceName[marketplaceId] ?? marketplaceId}</p>
              <ul className="divide-y text-xs">
                {rows.map((row) => (
                  <li key={row.warehouseId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
                    <span className="min-w-0 flex-1 truncate" title={row.warehouseName}>{row.warehouseName}</span>
                    {row.sentQty !== null ? <span className="tabular-nums text-muted-foreground">отправлено <b className="text-foreground">{qty(row.sentQty)}</b></span> : null}
                    <Badge variant="outline" className={correctionStatus[row.status]?.className}>{correctionStatus[row.status]?.label ?? row.status}</Badge>
                    {row.message && row.status !== "success" ? <span className="w-full text-muted-foreground">{row.message}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CheckLine({ event, open, onToggle }: { event: CheckEvent; open: boolean; onToggle: () => void }) {
  const summary = event.status === "error"
    ? event.message ?? "Площадки не ответили"
    : event.mismatches > 0
      ? `Расхождение с отправленным: ${event.mismatches} склад(ов)`
      : "Остатки на площадках совпадают с отправленными";
  const tone = event.status === "error" ? "text-rose-700" : event.mismatches > 0 ? "text-rose-700" : "text-foreground";
  return (
    <div>
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-muted/50">
        <EventTime at={event.at} />
        <Radar className={`mt-0.5 size-4 shrink-0 ${event.mismatches > 0 || event.status === "error" ? "text-rose-600" : "text-sky-600"}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Проверка остатков на площадках</p>
          <p className={`text-xs ${tone}`}>
            {summary}
            {event.errors > 0 && event.status !== "error" ? ` · не прочитано складов: ${event.errors}` : ""}
          </p>
        </div>
        {open ? <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
      </button>
      {open ? (
        <div className="space-y-2 px-4 pb-3 pl-[5.25rem]">
          {event.rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">{event.message ?? "Нет данных по складам."}</p>
          ) : groupByMarketplace(event.rows).map(([marketplaceId, rows]) => (
            <div key={marketplaceId} className="rounded-lg border">
              <p className="border-b bg-muted/40 px-3 py-1.5 text-xs font-semibold">{marketplaceName[marketplaceId] ?? marketplaceId}</p>
              <ul className="divide-y text-xs">
                {rows.map((row) => (
                  <li
                    key={row.warehouseId}
                    className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 ${row.mismatch ? "bg-rose-50 text-rose-900" : ""}`}
                  >
                    <span className="min-w-0 flex-1 truncate" title={row.warehouseName ?? row.warehouseId}>{row.warehouseName ?? row.warehouseId}</span>
                    {row.publishing ? null : <Badge variant="outline" className="border-dashed text-muted-foreground">склад отключён</Badge>}
                    {row.status === "error" ? (
                      <span className="text-rose-700">не прочитано{row.message ? `: ${row.message}` : ""}</span>
                    ) : row.status === "missing" ? (
                      <span className="tabular-nums text-muted-foreground">остаток <b className="text-foreground">0</b> · товар на складе не выставлен</span>
                    ) : (
                      <span className="tabular-nums">
                        остаток <b>{qty(row.amount)}</b>
                        {row.reserved ? <span className="text-muted-foreground">, в резерве {qty(row.reserved)}</span> : null}
                      </span>
                    )}
                    {row.mismatch ? (
                      <span className="font-medium text-rose-700">отправлено {qty(row.expectedQty)}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PendingLine({ event }: { event: PendingCheckEvent }) {
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <EventTime at={event.at} />
      <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Проверка остатков на площадках запланирована на {time(event.at)}</p>
    </div>
  );
}

export function StockHistoryDialog({
  sourceSku,
  title,
  onClose,
}: {
  /** Позиция, чья история открыта. Окно монтируется только на время показа. */
  sourceSku: string;
  title: string;
  onClose: () => void;
}) {
  const [days, setDays] = useState<number>(7);
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (sku: string, period: number) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/stocks/history?sourceSku=${encodeURIComponent(sku)}&days=${period}`, { cache: "no-store" });
      const payload = await response.json() as HistoryResponse;
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить историю.");
      setData(payload);
      // Раскрыты последние проверки и проверки с расхождением — остальное свёрнуто.
      const checks = payload.events.filter((event): event is CheckEvent => event.type === "check");
      const open = new Set(checks.filter((event) => event.mismatches > 0).map((event) => event.id));
      const latest = checks[checks.length - 1];
      if (latest) open.add(latest.id);
      setExpanded(open);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Не удалось загрузить историю.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void Promise.resolve().then(() => load(sourceSku, days)); }, [sourceSku, days, load]);

  // Лента идёт сверху вниз по времени: сразу показываем свежий конец.
  useEffect(() => {
    if (data && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [data]);

  const groups = useMemo(() => {
    const result: Array<{ key: string; title: string; events: HistoryEvent[] }> = [];
    for (const event of data?.events ?? []) {
      const key = dayKey(event.at);
      const last = result[result.length - 1];
      if (last?.key === key) last.events.push(event);
      else result.push({ key, title: dayTitle(event.at), events: [event] });
    }
    return result;
  }, [data]);

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <AlertDialogContent className="max-w-3xl data-[size=default]:sm:max-w-3xl">
        <AlertDialogHeader>
          <AlertDialogTitle>История остатков · {title}</AlertDialogTitle>
          <AlertDialogDescription>
            Заказы и отмены, корректировки остатка на складах площадок и проверка площадок через 10 минут после
            корректировки. Строку корректировки и проверки можно раскрыть — там данные по каждому складу.
            Красным отмечены склады, где остаток на площадке не совпал с отправленным.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Период:</span>
          {PERIODS.map((period) => (
            <Button
              key={period}
              size="sm"
              variant={days === period ? "secondary" : "outline"}
              onClick={() => setDays(period)}
              disabled={loading}
            >
              {period === 1 ? "сутки" : `${period} дней`}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => void load(sourceSku, days)} disabled={loading}>
            <RefreshCw className={loading ? "animate-spin" : ""} />Обновить
          </Button>
          {data && data.marketplaces.length > 0 ? (
            <span className="ml-auto flex flex-wrap gap-1">{data.marketplaces.map((id) => <MarketplaceBadge key={id} id={id} />)}</span>
          ) : null}
        </div>

        {error ? (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</p>
        ) : null}

        <div ref={listRef} className="max-h-[58vh] overflow-y-auto rounded-xl border">
          {loading && !data ? (
            <p className="flex items-center justify-center py-12 text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />Загружаем историю…</p>
          ) : groups.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {data?.marketplaces.length === 0
                ? "Позиция не сопоставлена ни с одной площадкой — событий нет."
                : "За выбранный период событий нет."}
            </p>
          ) : groups.map((group) => (
            <section key={group.key}>
              <h3 className="sticky top-0 z-10 border-b bg-muted px-4 py-1.5 text-xs font-semibold first-letter:uppercase">{group.title}</h3>
              <div className="divide-y">
                {group.events.map((event) => {
                  if (event.type === "check_pending") return <PendingLine key={event.id} event={event} />;
                  if (event.type === "correction") {
                    return <CorrectionLine key={event.id} event={event} open={expanded.has(event.id)} onToggle={() => toggle(event.id)} />;
                  }
                  if (event.type === "check") {
                    return <CheckLine key={event.id} event={event} open={expanded.has(event.id)} onToggle={() => toggle(event.id)} />;
                  }
                  return <OrderLine key={event.id} event={event} />;
                })}
              </div>
            </section>
          ))}
        </div>

        <AlertDialogFooter>
          <AlertDialogAction onClick={onClose}>Закрыть</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
