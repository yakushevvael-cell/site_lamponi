"use client";

/**
 * Экран сборщика.
 *
 * Своё задание и свободные задания — больше ничего. Ни сумм, ни цен, ни чужих
 * заданий: список урезается на сервере.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ClipboardList, Loader2, PackageCheck, Printer, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatAge, formatMoment } from "@/lib/utils";

type Task = {
  id: number;
  number: string;
  marketplaceId: "ozon" | "wildberries";
  warehouseName: string | null;
  status: "created" | "issued" | "picked" | "shipped" | "cancelled";
  assigneeEmail: string | null;
  orderCount: number;
  itemCount: number;
  unitCount: number;
  cellCount: number;
  pickedCount: number;
  notFoundCount: number;
  createdAt: string;
  issuedAt: string | null;
  pickedAt: string | null;
};

const MARKETPLACE_LABEL = { ozon: "Ozon", wildberries: "Wildberries" } as const;

function TaskCard({
  task,
  action,
  busy,
  onAction,
}: {
  task: Task;
  action: "open" | "take";
  busy: boolean;
  onAction: (task: Task) => void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4 px-5">
        <div className="min-w-0">
          <p className="font-mono text-xl font-bold">{task.number}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {MARKETPLACE_LABEL[task.marketplaceId]} · {task.warehouseName ?? "склад не указан"}
          </p>
          <p className="mt-1 text-sm">
            {task.itemCount} позиций · {task.unitCount} шт. · {task.cellCount} ячеек
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {task.status === "issued" && task.issuedAt ? `в работе ${formatAge(task.issuedAt)}` : `создано ${formatMoment(task.createdAt)}`}
            {task.notFoundCount > 0 ? ` · не найдено ${task.notFoundCount}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {task.status === "picked" ? <Badge className="bg-emerald-100 text-emerald-900 hover:bg-emerald-100">собрано</Badge> : null}
          {/* Лист подбора печатает сборщик: на нём код, которым открывается
              стол упаковки и поставка по этому заданию. */}
          {action === "open" ? (
            <Button asChild size="lg" variant="outline">
              <a href={`/print/pick-sheet?task=${task.id}`} target="_blank" rel="noreferrer">
                <Printer className="size-4" /> Лист подбора
              </a>
            </Button>
          ) : null}
          <Button size="lg" disabled={busy} onClick={() => onAction(task)}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <PackageCheck className="size-4" />}
            {action === "take" ? "Взять задание" : "Открыть"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function WarehousePickerWorkspace() {
  const router = useRouter();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [freeTasks, setFreeTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/warehouse/tasks?scope=mine", { cache: "no-store" });
    const data = await response.json() as { tasks?: Task[]; freeTasks?: Task[]; error?: string };
    if (!response.ok) throw new Error(data.error ?? "Задания не загрузились.");
    setTasks(data.tasks ?? []);
    setFreeTasks(data.freeTasks ?? []);
  }, []);

  useEffect(() => {
    void Promise.resolve()
      .then(() => load())
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Задания не загрузились."))
      .finally(() => setLoading(false));
  }, [load]);

  async function take(task: Task) {
    setBusyId(task.id);
    try {
      const response = await fetch("/api/warehouse/task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: task.id, action: "take" }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось взять задание.");
      router.push(`/warehouse/task?id=${task.id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось взять задание.");
      await load().catch(() => undefined);
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return <div className="grid min-h-72 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Загружаем задания…</div>;
  }

  const active = tasks.filter((task) => task.status === "issued");
  const done = tasks.filter((task) => task.status !== "issued");

  return (
    <div className="mx-auto max-w-[1000px] space-y-6 p-4 md:p-7">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 font-semibold"><ClipboardList className="size-4" /> В работе</p>
        <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw className="size-4" /> Обновить</Button>
      </div>
      {active.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          Нет задания в работе. Возьмите свободное из списка ниже.
        </p>
      ) : (
        <div className="space-y-3">
          {active.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              action="open"
              busy={busyId === task.id}
              onAction={(item) => router.push(`/warehouse/task?id=${item.id}`)}
            />
          ))}
        </div>
      )}

      <div>
        <p className="mb-3 font-semibold">Свободные задания</p>
        {freeTasks.length === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            Свободных заданий нет — кладовщик ещё не сформировал их.
          </p>
        ) : (
          <div className="space-y-3">
            {freeTasks.map((task) => (
              <TaskCard key={task.id} task={task} action="take" busy={busyId === task.id} onAction={(item) => void take(item)} />
            ))}
          </div>
        )}
      </div>

      {done.length > 0 ? (
        <div>
          <p className="mb-3 font-semibold">Закрытые за последнее время</p>
          <div className="space-y-2">
            {done.map((task) => (
              <Link
                key={task.id}
                href={`/warehouse/task?id=${task.id}`}
                className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm hover:bg-muted/40"
              >
                <span className="font-mono font-semibold">{task.number}</span>
                <span className="text-xs text-muted-foreground">
                  {task.itemCount} поз. · собрано {formatMoment(task.pickedAt)}
                  {task.notFoundCount > 0 ? ` · не найдено ${task.notFoundCount}` : ""}
                </span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
