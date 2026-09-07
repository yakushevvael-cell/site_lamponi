"use client";

import { useCallback, useEffect, useState } from "react";
import { Ban, CalendarDays, CheckCircle2, Loader2, PackageCheck, ReceiptRussianRuble, ShoppingBag, Warehouse } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Analytics = {
  summary: { orderCount: number; orderedUnits: number; orderAmount: number; buyoutOrders: number; canceledOrders: number; sellerCanceledOrders: number; buyoutRate: number };
  trend: Array<{ date: string; orders: number; buyouts: number; cancellations: number }>;
  marketplaces: Array<{ id: string; name: string; orders: number; amount: number; buyouts: number; cancellations: number; sellerCancellations: number; buyoutRate: number }>;
  productRatings: Array<{ article: string; units: number; buyouts: number; cancellations: number; sellerCancellations: number }>;
};
type StockTotals = { articleCount: number; skuCount: number; physicalQuantity: number; reservedQuantity: number; availableQuantity: number; zeroStockCount: number; manualZeroCount: number };
const money = (value: number) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(value);

export function DashboardOverview() {
  const [period, setPeriod] = useState("30");
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [stocks, setStocks] = useState<StockTotals | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (days: string) => {
    setLoading(true);
    try {
      const [analyticsResponse, stocksResponse] = await Promise.all([fetch(`/api/orders/analytics?days=${days}`, { cache: "no-store" }), fetch("/api/stocks?limit=1", { cache: "no-store" })]);
      const [analyticsData, stocksData] = await Promise.all([analyticsResponse.json(), stocksResponse.json()]) as [Analytics, { totals?: StockTotals }];
      if (analyticsResponse.ok) setAnalytics(analyticsData);
      if (stocksResponse.ok) setStocks(stocksData.totals ?? null);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void Promise.resolve().then(() => load(period)); }, [load, period]);
  const summary = analytics?.summary;
  const chartData = (analytics?.trend ?? []).map((row) => ({ ...row, label: new Date(row.date).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" }) }));

  return <main className="min-h-svh bg-background"><header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b bg-background/90 px-4 backdrop-blur md:px-7"><div className="flex items-center gap-3"><SidebarTrigger className="md:hidden" /><div><h1 className="text-lg font-semibold">Обзор бизнеса</h1><p className="hidden text-xs text-muted-foreground sm:block">Только реальные данные из ОСВ, WB и Ozon</p></div></div><Select value={period} onValueChange={setPeriod}><SelectTrigger className="w-[132px] bg-card"><CalendarDays className="size-4" /><SelectValue /></SelectTrigger><SelectContent><SelectItem value="7">7 дней</SelectItem><SelectItem value="30">30 дней</SelectItem><SelectItem value="90">90 дней</SelectItem></SelectContent></Select></header>
    <div className="mx-auto max-w-[1520px] space-y-6 p-4 md:p-7">{loading ? <div className="grid min-h-72 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Загружаем реальные показатели…</div> : <>
      <section className="flex flex-col gap-3 rounded-2xl border border-[#d8c79d] bg-[#f5edda] px-5 py-4 md:flex-row md:items-center md:justify-between"><div className="flex gap-3"><PackageCheck className="mt-0.5 size-5 text-[#74551d]" /><div><div className="flex flex-wrap items-center gap-2"><p className="font-semibold">Остаток из последней ОСВ</p><Badge variant="outline">реальные данные</Badge></div><p className="mt-1 text-sm text-[#6e624b]">{Number(stocks?.articleCount ?? 0).toLocaleString("ru-RU")} артикулов · {Number(stocks?.skuCount ?? 0).toLocaleString("ru-RU")} позиций · {Number(stocks?.physicalQuantity ?? 0).toLocaleString("ru-RU")} шт. физически · {Number(stocks?.manualZeroCount ?? 0).toLocaleString("ru-RU")} обнулено вручную</p></div></div><Button asChild><a href="/stocks">Управлять остатками</a></Button></section>
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">{[
        { label: "Заказы", value: Number(summary?.orderCount ?? 0).toLocaleString("ru-RU"), note: `${Number(summary?.orderedUnits ?? 0).toLocaleString("ru-RU")} шт.`, icon: ShoppingBag },
        { label: "Сумма заказов", value: money(summary?.orderAmount ?? 0), note: "WB + Ozon", icon: ReceiptRussianRuble },
        { label: "Выкупы", value: Number(summary?.buyoutOrders ?? 0).toLocaleString("ru-RU"), note: `${summary?.buyoutRate ?? 0}% завершённых`, icon: CheckCircle2 },
        { label: "Все отмены", value: Number(summary?.canceledOrders ?? 0).toLocaleString("ru-RU"), note: "все причины", icon: Ban },
        { label: "Отмены продавцом", value: Number(summary?.sellerCanceledOrders ?? 0).toLocaleString("ru-RU"), note: "отдельный показатель", icon: Ban },
      ].map((item) => <Card key={item.label} className="gap-0 py-5"><CardContent className="px-5"><div className="flex items-start justify-between"><div><p className="text-sm text-muted-foreground">{item.label}</p><p className="mt-2 text-2xl font-semibold">{item.value}</p><p className="mt-2 text-xs text-muted-foreground">{item.note}</p></div><span className="grid size-10 place-items-center rounded-xl bg-secondary"><item.icon className="size-4" /></span></div></CardContent></Card>)}</section>
      <section className="grid gap-4 xl:grid-cols-[1.4fr_0.8fr]"><Card><CardHeader><CardTitle className="text-base">Динамика заказов</CardTitle></CardHeader><CardContent className="h-[280px] px-2 sm:px-5">{chartData.length ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData} margin={{ left: -18, right: 12 }}><CartesianGrid vertical={false} strokeDasharray="4 4" /><XAxis dataKey="label" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} /><Tooltip /><Area dataKey="orders" name="Заказы" stroke="#8056d9" fill="#8056d9" fillOpacity={0.15} /><Area dataKey="buyouts" name="Выкупы" stroke="#228b63" fillOpacity={0} /><Area dataKey="cancellations" name="Отмены" stroke="#d24f63" fillOpacity={0} /></AreaChart></ResponsiveContainer> : <div className="grid h-full place-items-center text-sm text-muted-foreground">Загрузите заказы в разделе «Заказы».</div>}</CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Состояние остатка</CardTitle></CardHeader><CardContent className="space-y-4 px-5">{[
          ["Физически по ОСВ", stocks?.physicalQuantity ?? 0], ["В активных резервах", stocks?.reservedQuantity ?? 0], ["Доступно с учётом обнулений", stocks?.availableQuantity ?? 0], ["Обнулено вручную, позиций", stocks?.manualZeroCount ?? 0],
        ].map(([label, value]) => <div key={String(label)} className="flex items-center justify-between border-b pb-3 last:border-0"><span className="text-sm text-muted-foreground">{label}</span><span className="font-semibold">{Number(value).toLocaleString("ru-RU")}</span></div>)}<div className="rounded-xl bg-blue-50 p-3 text-xs leading-5 text-blue-800"><Warehouse className="mb-2 size-4" />Полную синхронизацию на склады администратор запускает во вкладке «Остатки».</div></CardContent></Card></section>
      <section className="grid gap-4 xl:grid-cols-2"><Card className="gap-0 overflow-hidden py-0"><div className="border-b px-5 py-4"><p className="font-semibold">Площадки</p></div><Table><TableHeader><TableRow><TableHead className="pl-5">Площадка</TableHead><TableHead className="text-right">Заказы</TableHead><TableHead className="text-right">Выкупы</TableHead><TableHead className="text-right">Отмены</TableHead><TableHead className="pr-5 text-right">Продавцом</TableHead></TableRow></TableHeader><TableBody>{analytics?.marketplaces.length ? analytics.marketplaces.map((row) => <TableRow key={row.id}><TableCell className="pl-5 font-semibold">{row.name}</TableCell><TableCell className="text-right">{row.orders}</TableCell><TableCell className="text-right">{row.buyouts}</TableCell><TableCell className="text-right">{row.cancellations}</TableCell><TableCell className="pr-5 text-right font-semibold">{row.sellerCancellations}</TableCell></TableRow>) : <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">Нет загруженных заказов.</TableCell></TableRow>}</TableBody></Table></Card>
        <Card className="gap-0 overflow-hidden py-0"><div className="border-b px-5 py-4"><p className="font-semibold">Лидеры по заказанным единицам</p></div><Table><TableHeader><TableRow><TableHead className="pl-5">Артикул</TableHead><TableHead className="text-right">Штук</TableHead><TableHead className="text-right">Выкупы</TableHead><TableHead className="pr-5 text-right">Отмены</TableHead></TableRow></TableHeader><TableBody>{analytics?.productRatings.length ? analytics.productRatings.slice(0, 8).map((row) => <TableRow key={row.article}><TableCell className="pl-5 font-mono text-xs font-semibold">{row.article}</TableCell><TableCell className="text-right">{row.units}</TableCell><TableCell className="text-right">{row.buyouts}</TableCell><TableCell className="pr-5 text-right">{row.cancellations}</TableCell></TableRow>) : <TableRow><TableCell colSpan={4} className="h-24 text-center text-muted-foreground">Нет данных.</TableCell></TableRow>}</TableBody></Table></Card></section>
    </>}</div>
  </main>;
}
