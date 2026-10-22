"use client";

/**
 * Подтверждение остатка обнулённых позиций по новой ОСВ.
 *
 * Один и тот же список показывается во всплывающем окне сразу после загрузки
 * ОСВ и на странице «Расхождения» — там ждёт всё, на что не ответили в окне.
 * «Да» возвращает позицию в продажу с остатком по ОСВ, «Нет» оставляет ноль
 * до тех пор, пока количество в ОСВ не изменится.
 */

import { useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatMoment } from "@/lib/utils";

export type ZeroDecision = {
  sourceSku: string;
  article: string;
  size: string | null;
  reason: "not_found" | "manual";
  osvQty: number;
  osvUnits: number;
  declinedQty: number | null;
  zeroedAt: string | null;
  taskNumber: string | null;
  blockedBy: string | null;
  blockedAt: string | null;
  failedOrderCount: number | null;
};

type DecisionResponse = {
  error?: string;
  confirmed?: string[];
  declined?: string[];
  stale?: string[];
  pushed?: { sent: number; error: string | null };
  items?: ZeroDecision[];
};

function qty(value: number) {
  return Number(value).toLocaleString("ru-RU");
}

export function ZeroDecisionsList({
  items,
  canDecide,
  onItemsChange,
}: {
  items: ZeroDecision[];
  canDecide: boolean;
  onItemsChange: (items: ZeroDecision[]) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(rows: ZeroDecision[], confirm: boolean, busyKey: string) {
    if (rows.length === 0) return;
    setBusy(busyKey);
    try {
      const response = await fetch("/api/stocks/zero-decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisions: rows.map((row) => ({ sourceSku: row.sourceSku, confirm, osvQty: row.osvQty })) }),
      });
      const data = await response.json() as DecisionResponse;
      if (!response.ok) throw new Error(data.error ?? "Решение не сохранено.");
      onItemsChange(data.items ?? []);

      const confirmed = data.confirmed?.length ?? 0;
      const declined = data.declined?.length ?? 0;
      if (confirmed > 0) {
        if (data.pushed?.error) {
          toast.warning(`Возвращено в продажу: ${confirmed}`, { description: `Остаток на площадки не ушёл: ${data.pushed.error} Позиции ждут в очереди доотправки.` });
        } else {
          toast.success(`Возвращено в продажу: ${confirmed}`, { description: "Остаток по ОСВ отправлен на площадки." });
        }
      }
      if (declined > 0) toast.success(`Оставлено с нулём: ${declined}`, { description: "Спросим снова, когда количество в ОСВ изменится." });
      if (data.stale?.length) toast.warning(`Не применено: ${data.stale.length}`, { description: "По этим позициям уже другая ОСВ или обнуление снято — список обновлён." });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Решение не сохранено.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {canDecide && items.length > 1 ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void decide(items, false, "all:no")}>
            {busy === "all:no" ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />} Нет всем
          </Button>
          <Button size="sm" disabled={busy !== null} onClick={() => void decide(items, true, "all:yes")}>
            {busy === "all:yes" ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Да всем
          </Button>
        </div>
      ) : null}
      <div className="max-h-[55svh] overflow-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Артикул</TableHead>
              <TableHead>Почему ноль</TableHead>
              <TableHead className="text-right">В новой ОСВ</TableHead>
              <TableHead className="pr-4 text-right">{canDecide ? "Остаток верный?" : ""}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((row) => (
              <TableRow key={row.sourceSku}>
                <TableCell className="pl-4">
                  <p className="font-mono text-sm font-semibold">{row.article}{row.size ? ` / ${row.size}` : ""}</p>
                </TableCell>
                <TableCell className="text-xs">
                  {row.reason === "not_found" ? (
                    <>
                      <Badge variant="destructive" className="text-[10px]">не найден при сборке</Badge>
                      <span className="mt-1 block text-muted-foreground">
                        {formatMoment(row.blockedAt)}{row.blockedBy ? ` · ${row.blockedBy}` : ""}
                        {row.taskNumber ? <span className="block font-mono">{row.taskNumber}</span> : null}
                        {row.failedOrderCount && row.failedOrderCount > 1 ? <span className="block">сорвано заказов: {row.failedOrderCount}</span> : null}
                      </span>
                    </>
                  ) : (
                    <>
                      <Badge variant="secondary" className="text-[10px]">обнулён вручную</Badge>
                      {row.zeroedAt ? <span className="mt-1 block text-muted-foreground">{formatMoment(row.zeroedAt)}</span> : null}
                    </>
                  )}
                </TableCell>
                <TableCell className="text-right text-sm">
                  <span className="font-semibold">{qty(row.osvQty)}</span>
                  {row.osvUnits !== row.osvQty ? <span className="block text-xs text-muted-foreground">на площадку {qty(row.osvUnits)}</span> : null}
                  {row.declinedQty !== null ? <span className="block text-xs text-muted-foreground">в прошлый раз «Нет» при {qty(row.declinedQty)}</span> : null}
                </TableCell>
                <TableCell className="pr-4 text-right">
                  {canDecide ? (
                    <div className="inline-flex gap-1.5">
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void decide([row], false, `no:${row.sourceSku}`)}>
                        {busy === `no:${row.sourceSku}` ? <Loader2 className="size-4 animate-spin" /> : null} Нет
                      </Button>
                      <Button size="sm" disabled={busy !== null} onClick={() => void decide([row], true, `yes:${row.sourceSku}`)}>
                        {busy === `yes:${row.sourceSku}` ? <Loader2 className="size-4 animate-spin" /> : null} Да
                      </Button>
                    </div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
            {items.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="h-20 text-center text-muted-foreground">Решений не ждёт ни одна позиция.</TableCell></TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** Окно после загрузки ОСВ. Закрыть можно в любой момент — неотвеченное ждёт на «Расхождениях». */
export function ZeroDecisionsDialog({
  open,
  items,
  canDecide,
  onItemsChange,
  onClose,
}: {
  open: boolean;
  items: ZeroDecision[];
  canDecide: boolean;
  onItemsChange: (items: ZeroDecision[]) => void;
  /** remaining — сколько позиций осталось без ответа. */
  onClose: (remaining: number) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(items.length); }}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Обнулённые товары появились в ОСВ</DialogTitle>
          <DialogDescription>
            Эти позиции не нашли при сборке или обнулили вручную, а в новой ОСВ по ним остаток больше нуля.
            {canDecide
              ? " «Да» — остаток верный: товар вернётся в продажу с остатком по ОСВ. «Нет» — остаётся ноль, снова спросим, когда количество в ОСВ изменится."
              : " Подтвердить остаток может сотрудник с правом «Подтверждение остатка и расхождения» — позиции ждут его на странице «Расхождения». До тех пор остаток по ним 0."}
          </DialogDescription>
        </DialogHeader>
        <ZeroDecisionsList
          items={items}
          canDecide={canDecide}
          onItemsChange={(next) => {
            onItemsChange(next);
            if (next.length === 0) onClose(0);
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(items.length)}>
            {items.length > 0 && canDecide ? "Решить позже" : "Закрыть"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
