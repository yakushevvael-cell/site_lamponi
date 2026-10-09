import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePagePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { currentMinute, readUnshippedAt, UNSHIPPED_WINDOW_DAYS, type UnshippedOrder } from "@/lib/unshipped";
import { formatMoscow, moscowInputToTime, timeToMoscowInput } from "@/lib/unshipped-core.mjs";

export const dynamic = "force-dynamic";

export default async function UnshippedPage({ searchParams }: { searchParams: Promise<{ at?: string }> }) {
  await requirePagePermission("/orders/unshipped", "money.view");
  const params = await searchParams;
  const requested = params.at ? moscowInputToTime(params.at) : null;
  const cutoff = requested ?? currentMinute();
  const at = timeToMoscowInput(cutoff);
  const db = getRuntimeEnv().DB;
  const orders: UnshippedOrder[] = db ? await readUnshippedAt(db, cutoff) : [];

  const byMarketplace = new Map<string, { orders: number; units: number }>();
  for (const order of orders) {
    const row = byMarketplace.get(order.marketplace) ?? { orders: 0, units: 0 };
    row.orders += 1;
    row.units += order.units;
    byMarketplace.set(order.marketplace, row);
  }

  return (
    <main className="min-h-svh bg-background">
      <PageHeader title="Не отгружено на момент" description="Заказы, которые в указанное время ещё ждали передачи в доставку" />
      <div className="space-y-5 p-4 md:p-7">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">Дата и время по Москве</span>
            <Input type="datetime-local" name="at" defaultValue={at} className="w-56" required />
          </label>
          <Button type="submit">Показать</Button>
          <Button asChild variant="outline">
            <Link href={`/api/orders/unshipped?at=${encodeURIComponent(at)}&format=csv`} prefetch={false}>Скачать для Excel</Link>
          </Button>
        </form>

        {params.at && requested === null ? (
          <p className="text-sm text-destructive">Не удалось разобрать время «{params.at}» — показано текущее.</p>
        ) : null}

        <div className="flex flex-wrap gap-3 text-sm">
          <div className="rounded-lg border px-4 py-2">
            Всего — заказов: <b>{orders.length}</b>, штук: <b>{orders.reduce((sum, order) => sum + order.units, 0)}</b>
          </div>
          {[...byMarketplace].map(([name, row]) => (
            <div key={name} className="rounded-lg border px-4 py-2">
              {name} — заказов: <b>{row.orders}</b>, штук: <b>{row.units}</b>
            </div>
          ))}
        </div>

        <p className="text-xs text-muted-foreground">
          Состояние восстановлено по датам событий заказа: оформлен до указанного времени и к нему ещё не передан в доставку
          и не отменён. Смотрятся заказы за {UNSHIPPED_WINDOW_DAYS} дней до этого момента. У Яндекс Маркета и части Ozon
          время передачи и отмены — момент, когда синхронизация это увидела, поэтому точность около 15 минут.
        </p>

        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Площадка</TableHead>
                <TableHead>Номер</TableHead>
                <TableHead>Оформлен</TableHead>
                <TableHead>Дедлайн</TableHead>
                <TableHead className="text-right">Ждал, ч</TableHead>
                <TableHead>Товары</TableHead>
                <TableHead className="text-right">Сумма</TableHead>
                <TableHead>Статус сейчас</TableHead>
                <TableHead>Передан</TableHead>
                <TableHead>Отменён</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.length ? orders.map((order) => (
                <TableRow key={`${order.marketplaceId}-${order.externalOrderId}`}>
                  <TableCell>{order.marketplace}</TableCell>
                  <TableCell className="font-mono text-xs">{order.externalOrderId}</TableCell>
                  <TableCell>{formatMoscow(order.orderedAt)}</TableCell>
                  <TableCell>{formatMoscow(order.shipmentDeadline) || "—"}</TableCell>
                  <TableCell className="text-right">{order.waitedHours}</TableCell>
                  <TableCell className="max-w-80 whitespace-normal">{order.items || "—"}</TableCell>
                  <TableCell className="text-right">{order.amount.toLocaleString("ru-RU")}</TableCell>
                  <TableCell className="font-mono text-xs">{order.status}</TableCell>
                  <TableCell>{formatMoscow(order.handedOverAt) || "—"}</TableCell>
                  <TableCell>{formatMoscow(order.canceledAt) || "—"}</TableCell>
                </TableRow>
              )) : (
                <TableRow>
                  <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                    На этот момент все заказы были отгружены или отменены.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </main>
  );
}
