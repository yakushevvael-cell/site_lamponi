"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DateRange } from "react-day-picker";
import { ru } from "date-fns/locale";
import { CalendarRange, CheckCircle2, Coins, Loader2, RefreshCw, ShoppingBag, Undo2 } from "lucide-react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Заказы и выкупы — разные события, поэтому разные тона; «заказы без отмен» —
 * те же заказы, поэтому тот же тон, но пунктиром. Пара тонов проверена на
 * различимость при дальтонизме.
 */
const ORDER_COLOR = "#8056d9";
const BUYOUT_COLOR = "#228b63";

const chartConfig = {
  orderAmount: { label: "Заказы, все", color: ORDER_COLOR },
  orderNetAmount: { label: "Заказы без отмен", color: ORDER_COLOR },
  buyoutAmount: { label: "Выкуплено", color: BUYOUT_COLOR },
} satisfies ChartConfig;

type DashboardDay = {
  date: string;
  orderAmount: number;
  orderNetAmount: number;
  orderCount: number;
  orderUnits: number;
  canceledAmount: number;
  buyoutAmount: number;
  buyoutCount: number;
  buyoutUnits: number;
  returnAmount: number;
};

type Dashboard = {
  marketplace: string;
  marketplaceName: string;
  from: string;
  to: string;
  days: number;
  ordersSource: "daily" | "fbs";
  series: DashboardDay[];
  totals: {
    orderAmount: number;
    orderNetAmount: number;
    canceledAmount: number;
    orderCount: number;
    orderUnits: number;
    buyoutAmount: number;
    buyoutCount: number;
    buyoutUnits: number;
    returnAmount: number;
    averageOrderPrice: number | null;
    averageOrderPricePerOrder: number | null;
    averageBuyoutPrice: number | null;
    averageBuyoutPricePerOrder: number | null;
  };
  financeReady: boolean;
  lastSync: { orders: string | null; finance: string | null };
};

const MARKETPLACES = [
  { id: "ozon", name: "Ozon" },
  { id: "wildberries", name: "Wildberries" },
];

function pad(value: number) {
  return String(value).padStart(2, "0");
}

/** Ключ дня из локальной даты: toISOString сдвинул бы её на часовой пояс. */
function toDayKey(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fromDayKey(key: string) {
  const [year, month, date] = key.split("-").map(Number);
  return new Date(year, (month || 1) - 1, date || 1);
}

function addDays(date: Date, count: number) {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + count);
  return shifted;
}

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(value);
}

function formatMoneyExact(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 2 }).format(value);
}

function formatUnits(value: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value);
}

function shortDate(key: string) {
  return fromDayKey(key).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
}

function longDate(key: string) {
  return fromDayKey(key).toLocaleDateString("ru-RU", { day: "2-digit", month: "long", weekday: "short" });
}

function rangeLabel(from: string, to: string) {
  const start = fromDayKey(from);
  const end = fromDayKey(to);
  const sameYear = start.getFullYear() === end.getFullYear();
  const startText = start.toLocaleDateString("ru-RU", { day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }) });
  const endText = end.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  return from === to ? endText : `${startText} — ${endText}`;
}

function compactMoney(value: number) {
  if (Math.abs(value) >= 1_000_000) return `${Math.round(value / 100_000) / 10} млн`;
  if (Math.abs(value) >= 1_000) return `${Math.round(value / 1_000)} тыс.`;
  return String(Math.round(value));
}

function formatSyncedAt(value: string | null | undefined) {
  if (!value) return "ещё не загружались";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "ещё не загружались" : parsed.toLocaleString("ru-RU");
}

function presetRanges(today: Date) {
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
  const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
  return [
    { label: "7 дней", from: addDays(today, -6), to: today },
    { label: "30 дней", from: addDays(today, -29), to: today },
    { label: "Этот месяц", from: startOfMonth, to: today },
    { label: "Прошлый месяц", from: lastMonthStart, to: lastMonthEnd },
  ];
}

export function MarketplaceDashboard({ canSync }: { canSync: boolean }) {
  const [marketplace, setMarketplace] = useState("ozon");
  const today = useMemo(() => new Date(), []);
  const [range, setRange] = useState<DateRange | undefined>(() => ({ from: addDays(new Date(), -29), to: new Date() }));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const autoSynced = useRef<Set<string>>(new Set());

  const fromKey = range?.from ? toDayKey(range.from) : toDayKey(addDays(today, -29));
  const toKey = range?.to ? toDayKey(range.to) : fromKey;
  // Синхронизация всегда тянет период от начала выбранного диапазона до сегодня.
  const syncDays = Math.max(7, Math.min(370, Math.ceil((today.getTime() - fromDayKey(fromKey).getTime()) / 86_400_000) + 2));

  const load = useCallback(async (id: string, from: string, to: string) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/dashboard?marketplace=${id}&from=${from}&to=${to}`, { cache: "no-store" });
      const payload = await response.json() as Dashboard & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить дашборд.");
      setData(payload);
    } catch (error) {
      toast.error("Дашборд не загружен", { description: error instanceof Error ? error.message : "Повторите попытку." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => load(marketplace, fromKey, toKey));
  }, [load, marketplace, fromKey, toKey]);

  // Данные подтягиваются фоном при открытии вкладки. На сервере стоит защита от
  // частых запусков, поэтому открытая страница не создаёт нагрузки на площадку.
  useEffect(() => {
    if (!canSync) return;
    if (autoSynced.current.has(marketplace)) return;
    autoSynced.current.add(marketplace);
    void fetch("/api/finance/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketplace, days: syncDays, force: false }),
    }).then(() => load(marketplace, fromKey, toKey)).catch(() => undefined);
  }, [canSync, load, marketplace, fromKey, toKey, syncDays]);

  async function refresh() {
    setSyncing(true);
    try {
      const response = await fetch("/api/finance/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketplace, days: syncDays, force: true }),
      });
      const payload = await response.json() as { errors?: Array<{ marketplace: string; message: string }>; error?: string };
      if (!response.ok && response.status !== 207) {
        throw new Error(payload.error ?? payload.errors?.map((item) => item.message).join(" ") ?? "Обновление не выполнено.");
      }
      if (payload.errors?.length) {
        toast.warning("Часть данных не обновилась", { description: payload.errors.map((item) => item.message).join(" ") });
      } else {
        toast.success("Данные обновлены");
      }
      await load(marketplace, fromKey, toKey);
    } catch (error) {
      toast.error("Данные не обновлены", { description: error instanceof Error ? error.message : "Повторите попытку." });
    } finally {
      setSyncing(false);
    }
  }

  function applyRange(next: DateRange | undefined) {
    setRange(next);
    if (next?.from && next?.to) setPickerOpen(false);
  }

  const totals = data?.totals;
  const series = useMemo(
    () => (data?.series ?? []).map((row) => ({ ...row, label: shortDate(row.date) })),
    [data],
  );
  const tableRows = useMemo(
    () => series.filter((row) => row.orderAmount > 0 || row.buyoutAmount > 0 || row.returnAmount > 0).slice().reverse(),
    [series],
  );
  const hasData = tableRows.length > 0;

  const cards = [
    {
      label: "Заказано за период",
      value: formatMoney(totals?.orderAmount ?? 0),
      note: `${totals?.orderCount ?? 0} заказов · ${formatUnits(totals?.orderUnits ?? 0)} шт.`,
      icon: ShoppingBag,
    },
    {
      label: "Заказано без отмен",
      value: formatMoney(totals?.orderNetAmount ?? 0),
      note: `отменено на ${formatMoney(totals?.canceledAmount ?? 0)}`,
      icon: CalendarRange,
    },
    {
      label: "Выкуплено за период",
      value: formatMoney(totals?.buyoutAmount ?? 0),
      note: `${totals?.buyoutCount ?? 0} отправлений · ${formatUnits(totals?.buyoutUnits ?? 0)} шт.`,
      icon: CheckCircle2,
    },
    {
      label: "Средняя цена заказа",
      value: formatMoneyExact(totals?.averageOrderPrice),
      note: `за штуку · за заказ ${formatMoneyExact(totals?.averageOrderPricePerOrder)}`,
      icon: Coins,
    },
    {
      label: "Средняя цена выкупа",
      value: formatMoneyExact(totals?.averageBuyoutPrice),
      note: `за штуку · за отправление ${formatMoneyExact(totals?.averageBuyoutPricePerOrder)}`,
      icon: Coins,
    },
    {
      label: "Возвраты за период",
      value: formatMoney(totals?.returnAmount ?? 0),
      note: "уже вычтены из выкупов того дня, когда пришёл возврат",
      icon: Undo2,
    },
  ];

  return (
    <div className="mx-auto max-w-[1520px] space-y-5 p-4 md:p-7">
      <Tabs value={marketplace} onValueChange={setMarketplace}>
        <div className="flex flex-col gap-3 rounded-2xl border bg-card p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <TabsList>
              {MARKETPLACES.map((item) => <TabsTrigger key={item.id} value={item.id}>{item.name}</TabsTrigger>)}
            </TabsList>
            <p className="mt-2 max-w-xl text-xs text-muted-foreground">
              Все суммы — по цене, которую установил продавец, и по всем схемам продаж, включая склад площадки.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" className="justify-start font-normal">
                  <CalendarRange />
                  {rangeLabel(fromKey, toKey)}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-auto p-0">
                <div className="flex flex-wrap gap-1 border-b p-2">
                  {presetRanges(today).map((preset) => (
                    <Button
                      key={preset.label}
                      variant="ghost"
                      size="sm"
                      onClick={() => applyRange({ from: preset.from, to: preset.to })}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
                <Calendar
                  mode="range"
                  locale={ru}
                  defaultMonth={range?.from ?? today}
                  selected={range}
                  onSelect={applyRange}
                  numberOfMonths={2}
                  disabled={{ after: today }}
                />
              </PopoverContent>
            </Popover>
            {canSync ? (
              <Button variant="outline" onClick={() => void refresh()} disabled={syncing}>
                {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {syncing ? "Обновляем…" : "Обновить"}
              </Button>
            ) : null}
          </div>
        </div>

        {MARKETPLACES.map((item) => (
          <TabsContent key={item.id} value={item.id} className="space-y-5">
            {loading ? (
              <div className="grid min-h-72 place-items-center text-sm text-muted-foreground">
                <span><Loader2 className="mr-2 inline size-4 animate-spin" />Считаем показатели {item.name}…</span>
              </div>
            ) : (
              <>
                {data?.ordersSource === "fbs" ? (
                  <p className="rounded-xl border border-dashed px-4 py-3 text-xs text-muted-foreground">
                    Заказы пока показаны только по своему складу — полные данные по всем схемам появятся после
                    первой загрузки. Нажмите «Обновить».
                  </p>
                ) : null}

                <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {cards.map((card) => (
                    <Card key={card.label} className="gap-0 py-5">
                      <CardContent className="px-5">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm text-muted-foreground">{card.label}</p>
                            <p className="mt-2 text-2xl font-semibold">{card.value}</p>
                            <p className="mt-2 text-xs text-muted-foreground">{card.note}</p>
                          </div>
                          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-secondary">
                            <card.icon className="size-4" />
                          </span>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </section>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Заказы и выкупы по дням, ₽ по цене продавца</CardTitle>
                  </CardHeader>
                  <CardContent className="px-2 sm:px-5">
                    {hasData ? (
                      <ChartContainer config={chartConfig} className="aspect-auto h-[320px] w-full">
                        <LineChart data={series} margin={{ left: 4, right: 16, top: 8 }}>
                          <CartesianGrid vertical={false} strokeDasharray="4 4" />
                          <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={16} tickMargin={8} />
                          <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={compactMoney} />
                          <ChartTooltip
                            content={
                              <ChartTooltipContent
                                labelFormatter={(_value, payload) => {
                                  const day = payload?.[0]?.payload as DashboardDay | undefined;
                                  return day ? longDate(day.date) : "";
                                }}
                                formatter={(value, name, entry) => (
                                  <div className="flex w-full items-center gap-2">
                                    <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: entry?.color }} />
                                    <span className="text-muted-foreground">{chartConfig[String(name) as keyof typeof chartConfig]?.label ?? String(name)}</span>
                                    <span className="ml-auto font-mono font-medium tabular-nums">{formatMoney(Number(value))}</span>
                                  </div>
                                )}
                              />
                            }
                          />
                          <ChartLegend content={<ChartLegendContent />} />
                          <Line type="monotone" dataKey="orderAmount" stroke="var(--color-orderAmount)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                          <Line type="monotone" dataKey="orderNetAmount" stroke="var(--color-orderNetAmount)" strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={{ r: 4 }} />
                          <Line type="monotone" dataKey="buyoutAmount" stroke="var(--color-buyoutAmount)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                        </LineChart>
                      </ChartContainer>
                    ) : (
                      <div className="grid h-[320px] place-items-center px-6 text-center text-sm text-muted-foreground">
                        За выбранные дни данных нет. Выберите другой период или нажмите «Обновить».
                      </div>
                    )}
                  </CardContent>
                </Card>

                {data && !data.financeReady ? (
                  <p className="rounded-xl border border-dashed px-4 py-3 text-xs text-muted-foreground">
                    Выкупы за период не загружены. {item.id === "ozon"
                      ? "Ozon отдаёт их в начислениях по отправлениям — у API-ключа должен быть доступ к разделу «Финансы и отчёты»."
                      : "Wildberries отдаёт их в отчёте «Продажи» — у ключа должна быть категория «Статистика»."}
                  </p>
                ) : null}

                <Card className="gap-0 overflow-hidden py-0">
                  <div className="border-b px-5 py-4">
                    <p className="font-semibold">Те же данные таблицей</p>
                    <p className="mt-1 text-xs text-muted-foreground">Дни без заказов и выкупов пропущены.</p>
                  </div>
                  <div className="max-h-[420px] overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="pl-5">Дата</TableHead>
                          <TableHead className="text-right">Заказы, все</TableHead>
                          <TableHead className="text-right">Без отмен</TableHead>
                          <TableHead className="text-right">Выкуплено</TableHead>
                          <TableHead className="pr-5 text-right">Возвраты</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {tableRows.length ? tableRows.map((row) => (
                          <TableRow key={row.date}>
                            <TableCell className="pl-5 whitespace-nowrap">{longDate(row.date)}</TableCell>
                            <TableCell className="text-right">{formatMoney(row.orderAmount)}</TableCell>
                            <TableCell className="text-right">{formatMoney(row.orderNetAmount)}</TableCell>
                            <TableCell className="text-right font-semibold">{formatMoney(row.buyoutAmount)}</TableCell>
                            <TableCell className="pr-5 text-right text-muted-foreground">
                              {row.returnAmount > 0 ? formatMoney(row.returnAmount) : "—"}
                            </TableCell>
                          </TableRow>
                        )) : (
                          <TableRow><TableCell colSpan={5} className="h-28 text-center text-muted-foreground">Нет данных за период.</TableCell></TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </Card>

                <p className="text-xs text-muted-foreground">
                  Данные обновлены: {formatSyncedAt(data?.lastSync.finance)}. Заказы своего склада: {formatSyncedAt(data?.lastSync.orders)}.
                </p>
              </>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
