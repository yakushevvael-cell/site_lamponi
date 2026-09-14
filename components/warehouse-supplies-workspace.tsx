"use client";

/**
 * Оформление поставок (ТЗ, п. 6).
 *
 * Один склад = одна поставка. Кнопка активна, когда по заданию всё
 * отсканировано и проблемные разобраны — иначе поставку потом не закрыть.
 * Документы печатаются прямо из браузера и лежат на сервере.
 */

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Loader2,
  MapPin,
  Printer,
  RefreshCw,
  Truck,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { formatMoment } from "@/lib/utils";

type Task = {
  id: number;
  number: string;
  marketplaceId: "ozon" | "wildberries";
  warehouseName: string | null;
  status: string;
  itemCount: number;
};

type DropoffPoint = { id: number; marketplaceId: string; name: string; address: string | null; lastUsedAt: string | null };

type SupplyDocument = { kind: string; label: string; storageKey: string; contentType: string };

type Supply = {
  id: number;
  marketplaceId: "ozon" | "wildberries";
  taskId: number | null;
  externalId: string | null;
  name: string | null;
  status: "created" | "closed" | "error";
  boxCount: number;
  postingCount: number;
  dropoffName: string | null;
  error: string | null;
  createdAt: string;
  closedAt: string | null;
  documents: SupplyDocument[];
};

type Blocker = { reason: string; details: string[] } | null;

export function WarehouseSuppliesWorkspace({ initialTaskId }: { initialTaskId: number | null }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskId, setTaskId] = useState<number | null>(initialTaskId);
  const [points, setPoints] = useState<DropoffPoint[]>([]);
  const [pointId, setPointId] = useState<number | null>(null);
  const [boxCount, setBoxCount] = useState("1");
  const [supplies, setSupplies] = useState<Supply[]>([]);
  const [blocker, setBlocker] = useState<Blocker>(null);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    const response = await fetch("/api/warehouse/tasks", { cache: "no-store" });
    const data = await response.json() as { tasks?: Task[]; error?: string };
    if (!response.ok) throw new Error(data.error ?? "Задания не загрузились.");
    const ready = (data.tasks ?? []).filter((task) => task.status === "picked");
    setTasks(ready);
    setTaskId((current) => current ?? ready[0]?.id ?? null);
  }, []);

  const loadSupplies = useCallback(async (id: number | null) => {
    const response = await fetch(`/api/warehouse/supplies${id ? `?task=${id}` : ""}`, { cache: "no-store" });
    const data = await response.json() as {
      supplies?: Supply[]; blocker?: Blocker; dropoffPoints?: DropoffPoint[]; canManage?: boolean; error?: string;
    };
    if (!response.ok) throw new Error(data.error ?? "Поставки не загрузились.");
    setSupplies(data.supplies ?? []);
    setBlocker(data.blocker ?? null);
    setPoints(data.dropoffPoints ?? []);
    setCanManage(Boolean(data.canManage));
    // Последний выбор запоминается: список уже отсортирован по времени использования.
    setPointId((current) => current ?? data.dropoffPoints?.[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void Promise.all([loadTasks(), loadSupplies(initialTaskId)])
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Не загрузилось."))
      .finally(() => setLoading(false));
  }, [loadTasks, loadSupplies, initialTaskId]);

  useEffect(() => {
    if (loading) return;
    void loadSupplies(taskId).catch(() => undefined);
  }, [taskId, loading, loadSupplies]);

  async function refreshPoints() {
    setBusy("points");
    try {
      const response = await fetch("/api/warehouse/dropoff", { method: "POST" });
      const data = await response.json() as { points?: DropoffPoint[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось обновить точки сдачи.");
      setPoints(data.points ?? []);
      toast.success(`Точки сдачи обновлены: ${data.points?.length ?? 0}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось обновить точки сдачи.");
    } finally {
      setBusy(null);
    }
  }

  async function createSupply() {
    if (!taskId) return;
    setBusy("create");
    try {
      const response = await fetch("/api/warehouse/supplies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", taskId, boxCount: Number(boxCount), dropoffPointId: pointId }),
      });
      const data = await response.json() as { supply?: Supply; error?: string; details?: string[] };
      if (!response.ok) {
        throw new Error([data.error, ...(data.details ?? []).slice(0, 5)].filter(Boolean).join(" · "));
      }
      if (data.supply?.status === "error") {
        toast.error("Площадка отклонила оформление", { description: data.supply.error ?? undefined });
      } else {
        toast.success("Поставка оформлена", { description: "Печатайте QR и акт из списка ниже." });
      }
      await Promise.all([loadTasks(), loadSupplies(taskId)]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось оформить поставку.");
    } finally {
      setBusy(null);
    }
  }

  async function refreshDocuments(supply: Supply) {
    setBusy(`docs:${supply.id}`);
    try {
      const response = await fetch("/api/warehouse/supplies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh_documents", supplyId: supply.id }),
      });
      const data = await response.json() as { status?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось обновить документы.");
      toast.success("Документы обновлены", { description: data.status ? `Статус акта: ${data.status}` : undefined });
      await loadSupplies(taskId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось обновить документы.");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return <div className="grid min-h-72 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Загружаем поставки…</div>;
  }

  const task = tasks.find((item) => item.id === taskId) ?? null;
  const marketplacePoints = points.filter((point) => !task || point.marketplaceId === task.marketplaceId);

  return (
    <div className="mx-auto max-w-[1200px] space-y-6 p-4 md:p-7">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Truck className="size-4" /> Оформить поставку</CardTitle>
          <CardDescription>
            Задание попадает сюда, когда собрано. Wildberries: поставка, короба и QR. Ozon: акт приёма-передачи —
            он готовится не мгновенно, документы догружаются кнопкой.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-5">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Задание</Label>
              <NativeSelect
                className="w-72"
                value={taskId ?? ""}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setTaskId(Number.isFinite(next) && next > 0 ? next : null);
                }}
              >
                <option value="">Выберите задание…</option>
                {tasks.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.number} — {item.marketplaceId === "ozon" ? "Ozon" : "WB"}
                    {item.warehouseName ? ` · ${item.warehouseName}` : ""}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Точка сдачи</Label>
              <NativeSelect
                className="w-64"
                value={pointId ?? ""}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setPointId(Number.isFinite(next) && next > 0 ? next : null);
                }}
              >
                <option value="">Не выбрана</option>
                {marketplacePoints.map((point) => (
                  <option key={point.id} value={point.id}>{point.name}</option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Коробов</Label>
              <Input className="w-24" inputMode="numeric" value={boxCount} onChange={(event) => setBoxCount(event.target.value)} />
            </div>
            <Button disabled={!taskId || Boolean(blocker) || busy !== null || !canManage} onClick={() => void createSupply()}>
              {busy === "create" ? <Loader2 className="size-4 animate-spin" /> : <Truck className="size-4" />} Оформить поставку
            </Button>
            <Button variant="ghost" disabled={busy !== null} onClick={() => void refreshPoints()}>
              {busy === "points" ? <Loader2 className="size-4 animate-spin" /> : <MapPin className="size-4" />} Обновить точки сдачи
            </Button>
          </div>

          {blocker ? (
            <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" /> {blocker.reason}</p>
              {blocker.details.length > 0 ? (
                <ul className="mt-1 list-inside list-disc font-mono text-xs">
                  {blocker.details.map((line) => <li key={line}>{line}</li>)}
                </ul>
              ) : null}
            </div>
          ) : taskId ? (
            <p className="flex items-center gap-2 text-sm text-emerald-800">
              <CheckCircle2 className="size-4" /> Задание готово к отгрузке: всё отсканировано, проблемных нет.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div className="space-y-3">
        <p className="flex items-center gap-2 font-semibold"><Boxes className="size-4" /> Поставки</p>
        {supplies.length === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            Поставок пока нет.
          </p>
        ) : supplies.map((supply) => (
          <Card key={supply.id}>
            <CardContent className="space-y-3 px-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-lg font-bold">
                    {supply.externalId ?? `№${supply.id}`}
                    <span className="ml-2 text-sm font-normal text-muted-foreground">
                      {supply.marketplaceId === "ozon" ? "Ozon" : "Wildberries"}
                    </span>
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    задание {supply.name ?? "—"} · {supply.postingCount} отправлений · {supply.boxCount} коробов
                    {supply.dropoffName ? ` · ${supply.dropoffName}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    оформлена {formatMoment(supply.createdAt)}
                    {supply.closedAt ? ` · закрыта ${formatMoment(supply.closedAt)}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {supply.status === "error" ? <Badge variant="destructive">ошибка</Badge> : null}
                  {supply.status === "closed" ? <Badge className="bg-emerald-100 text-emerald-900 hover:bg-emerald-100">закрыта</Badge> : null}
                  {supply.marketplaceId === "ozon" ? (
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void refreshDocuments(supply)}>
                      {busy === `docs:${supply.id}` ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Обновить документы
                    </Button>
                  ) : null}
                </div>
              </div>

              {supply.error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-900">{supply.error}</p> : null}

              <div className="flex flex-wrap gap-2">
                {supply.documents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Документов пока нет.</p>
                ) : supply.documents.map((document, index) => (
                  document.storageKey ? (
                    <Button key={`${document.kind}-${index}`} asChild size="sm" variant="outline">
                      <a
                        href={`/api/warehouse/supplies/file?supply=${supply.id}&document=${index}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Printer className="size-4" /> {document.label}
                      </a>
                    </Button>
                  ) : (
                    <span key={`${document.kind}-${index}`} className="rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
                      {document.label}
                    </span>
                  )
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
