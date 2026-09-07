"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type LogRow = {
  id: number;
  runId: string;
  marketplaceId: string;
  warehouseId: string | null;
  warehouseName: string | null;
  article: string | null;
  size: string | null;
  externalSku: string | null;
  osvQty: number | null;
  reserveQty: number | null;
  computedQty: number | null;
  sentQty: number | null;
  apiStatus: "success" | "error" | "blocked" | "skipped";
  apiMessage: string | null;
  actorEmail: string | null;
  createdAt: string;
};

type RunRow = {
  id: string;
  status: string;
  trigger: string;
  osvUploadId: number | null;
  actorEmail: string | null;
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
};

const statusLabels: Record<LogRow["apiStatus"], { label: string; className: string }> = {
  success: { label: "Отправлено", className: "bg-emerald-100 text-emerald-800 hover:bg-emerald-100" },
  error: { label: "Ошибка API", className: "bg-red-100 text-red-800 hover:bg-red-100" },
  blocked: { label: "Заблокировано проверкой", className: "bg-amber-100 text-amber-900 hover:bg-amber-100" },
  skipped: { label: "Пропущено", className: "bg-slate-100 text-slate-700 hover:bg-slate-100" },
};

const runLabels: Record<string, string> = {
  manual: "Ручной запуск",
  osv_upload: "Загрузка ОСВ",
  orders_sync: "Синхронизация заказов",
  warehouse_enabled: "Включение склада",
  warehouse_disabled: "Отключение склада",
  manual_zero: "Ручное обнуление",
  canary: "Канареечный тест",
};

function qty(value: number | null) {
  return value === null || value === undefined ? "—" : Number(value).toLocaleString("ru-RU");
}

export function SyncLogWorkspace() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [article, setArticle] = useState("");
  const [status, setStatus] = useState("");
  const [runId, setRunId] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (nextArticle: string, nextStatus: string, nextRun: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (nextArticle) params.set("article", nextArticle);
      if (nextStatus) params.set("status", nextStatus);
      if (nextRun) params.set("runId", nextRun);
      const response = await fetch(`/api/stocks/logs?${params.toString()}`, { cache: "no-store" });
      const data = await response.json() as { rows?: LogRow[]; runs?: RunRow[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить журнал.");
      setRows(data.rows ?? []);
      setRuns(data.runs ?? []);
    } catch (error) {
      toast.error("Журнал не загружен", { description: error instanceof Error ? error.message : "Повторите попытку." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load("", "", "");
  }, [load]);

  return <div className="mx-auto max-w-[1520px] space-y-5 p-4 md:p-7">
    <Card>
      <CardHeader className="px-5"><CardTitle className="text-base">Запуски синхронизации</CardTitle></CardHeader>
      <CardContent className="px-5">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-xs uppercase text-muted-foreground">
              <tr><th className="py-2 text-left">Начало</th><th className="text-left">Причина</th><th className="text-left">Статус</th><th className="text-left">ОСВ</th><th className="text-left">Пользователь</th><th className="text-left">Комментарий</th><th /></tr>
            </thead>
            <tbody>
              {runs.map((run) => <tr key={run.id} className="border-t">
                <td className="py-2 whitespace-nowrap">{new Date(run.startedAt).toLocaleString("ru-RU")}</td>
                <td>{runLabels[run.trigger] ?? run.trigger}</td>
                <td>{run.status}</td>
                <td>{run.osvUploadId ?? "—"}</td>
                <td className="max-w-40 truncate">{run.actorEmail ?? "—"}</td>
                <td className="max-w-72 truncate text-muted-foreground">{run.message ?? ""}</td>
                <td><Button size="sm" variant="ghost" onClick={() => { setRunId(run.id); void load(article, status, run.id); }}>Строки</Button></td>
              </tr>)}
              {runs.length === 0 && !loading ? <tr><td colSpan={7} className="py-4 text-muted-foreground">Синхронизаций ещё не было.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader className="px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">Строки выгрузки</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={article}
              onChange={(event) => setArticle(event.target.value)}
              placeholder="Артикул или SKU"
              className="h-9 w-52"
            />
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="h-9 w-52 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Все статусы</option>
              <option value="success">Отправлено</option>
              <option value="error">Ошибка API</option>
              <option value="blocked">Заблокировано проверкой</option>
              <option value="skipped">Пропущено</option>
            </select>
            {runId ? <Button size="sm" variant="ghost" onClick={() => { setRunId(""); void load(article, status, ""); }}>Все запуски</Button> : null}
            <Button size="sm" variant="outline" disabled={loading} onClick={() => void load(article, status, runId)}>
              {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Обновить
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-5">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-2 text-left">Время</th>
                <th className="text-left">Площадка</th>
                <th className="text-left">Склад</th>
                <th className="text-left">Артикул</th>
                <th className="text-left">Размер</th>
                <th className="text-right">ОСВ</th>
                <th className="text-right">Резерв</th>
                <th className="text-right">Расчёт</th>
                <th className="text-right">Передано</th>
                <th className="text-left">Статус</th>
                <th className="text-left">Ответ API</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {rows.map((row) => <tr key={row.id} className="border-t">
                <td className="py-2 whitespace-nowrap">{new Date(row.createdAt).toLocaleString("ru-RU")}</td>
                <td>{row.marketplaceId}</td>
                <td className="max-w-48 truncate">{row.warehouseName ?? row.warehouseId ?? "—"}<span className="block text-[10px] text-muted-foreground">{row.warehouseId}</span></td>
                <td>{row.article ?? row.externalSku ?? "—"}</td>
                <td>{row.size ?? "—"}</td>
                <td className="text-right">{qty(row.osvQty)}</td>
                <td className="text-right">{qty(row.reserveQty)}</td>
                <td className="text-right">{qty(row.computedQty)}</td>
                <td className="text-right font-semibold">{qty(row.sentQty)}</td>
                <td><Badge className={statusLabels[row.apiStatus]?.className}>{statusLabels[row.apiStatus]?.label ?? row.apiStatus}</Badge></td>
                <td className="max-w-72 truncate text-muted-foreground">{row.apiMessage ?? ""}</td>
              </tr>)}
              {rows.length === 0 && !loading ? <tr><td colSpan={11} className="py-4 text-muted-foreground">Записей нет.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  </div>;
}
