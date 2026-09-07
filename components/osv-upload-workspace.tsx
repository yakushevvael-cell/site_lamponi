"use client";

import { ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileSpreadsheet,
  History,
  Loader2,
  RefreshCw,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { describeSummary, runFullStockSync } from "@/lib/stock-sync-client";

type OsvDiff = {
  changedCount: number;
  addedCount: number;
  disappearedCount: number;
  quantityBefore: number;
  quantityAfter: number;
  topChanges: Array<{ sourceSku: string; article: string; size: string | null; before: number; after: number; delta: number }>;
};

type OsvPreview = {
  fileName: string;
  balanceDate: string;
  sheetName: string;
  quantityColumn: string;
  headerRowNumber: number;
  articleCount: number;
  variantCount: number;
  sizedVariantCount: number;
  unsizedVariantCount: number;
  totalQuantity: number;
  reportedTotal: number | null;
  zeroQuantityCount: number;
  warnings: string[];
  blockers: string[];
  diff: OsvDiff;
};

type UploadHistoryItem = {
  id: number;
  fileName: string;
  status: "processed" | "failed";
  articleCount: number;
  skuCount: number;
  sizedVariantCount: number;
  totalQuantity: number;
  zeroQuantityCount: number;
  warningCount: number;
  uploadedBy: string | null;
  createdAt: string;
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(`${value.replace(" ", "T")}Z`));
}

function formatSize(bytes: number) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.ceil(bytes / 1024)} КБ`;
}

export function OsvUploadWorkspace() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<OsvPreview | null>(null);
  const [balanceDate, setBalanceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [acceptBlockers, setAcceptBlockers] = useState(false);
  const [syncProgress, setSyncProgress] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [parsing, setParsing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [history, setHistory] = useState<UploadHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const response = await fetch("/api/osv", { cache: "no-store" });
      const data = await response.json() as { uploads?: UploadHistoryItem[] };
      setHistory(data.uploads ?? []);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/osv", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: { uploads?: UploadHistoryItem[] }) => {
        if (active) setHistory(data.uploads ?? []);
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });
    return () => { active = false; };
  }, []);

  const inspectFile = useCallback(async (selected: File, forDate: string) => {
    setFile(selected);
    setPreview(null);
    setPreviewError("");
    setAcceptBlockers(false);
    if (!selected.name.toLowerCase().endsWith(".xlsx")) {
      setPreviewError("Нужен файл Excel в формате .xlsx.");
      return;
    }
    setParsing(true);
    try {
      // Предпросмотр считает сервер: те же правила разбора, что и при
      // применении, плюс сравнение «было / стало» с текущими остатками.
      const body = new FormData();
      body.set("file", selected);
      body.set("mode", "preview");
      body.set("balanceDate", forDate);
      const response = await fetch("/api/osv", { method: "POST", body });
      const data = await response.json() as { preview?: OsvPreview; error?: string };
      if (!response.ok || !data.preview) throw new Error(data.error ?? "Не удалось прочитать файл.");
      setPreview(data.preview);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "Не удалось прочитать файл.");
    } finally {
      setParsing(false);
    }
  }, []);

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    if (selected) void inspectFile(selected, balanceDate);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const selected = event.dataTransfer.files?.[0];
    if (selected) void inspectFile(selected, balanceDate);
  };

  const upload = async () => {
    if (!file || !preview) return;
    setUploading(true);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("mode", "apply");
      body.set("balanceDate", balanceDate);
      if (acceptBlockers) body.set("acceptBlockers", "1");
      const response = await fetch("/api/osv", { method: "POST", body });
      const data = await response.json() as { error?: string; reservations?: { active: number; reservedQuantity: number } };
      if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить ОСВ.");
      toast.success("Остатки обновлены", {
        description: `${preview.articleCount.toLocaleString("ru-RU")} артикулов · ${preview.variantCount.toLocaleString("ru-RU")} позиций · ${preview.totalQuantity.toLocaleString("ru-RU")} шт. Резерв пересчитан: ${(data.reservations?.reservedQuantity ?? 0).toLocaleString("ru-RU")} шт.`,
      });
      setFile(null);
      setPreview(null);
      setAcceptBlockers(false);
      if (inputRef.current) inputRef.current.value = "";
      await loadHistory();

      // ТЗ, п. 8: синхронизация запускается после загрузки новой ОСВ.
      // Фоновых задач на этом хостинге нет, поэтому цикл ведёт эта же вкладка.
      try {
        const summary = await runFullStockSync({
        onProgress: setSyncProgress,
        // Массовое обнуление подтверждает человек: автоматически такой запуск не идёт.
        onMassZero: (info) => window.confirm(`${info.message}\n\nОтправить нули на площадки?`),
      });
        const description = describeSummary(summary);
        if (summary.ok) toast.success("Остатки отправлены на площадки", { description });
        else toast.warning("Синхронизация завершена частично", { description });
      } catch (error) {
        toast.warning("ОСВ загружена, остатки не отправлены", {
          description: `${error instanceof Error ? error.message : "Повторите попытку."} Запустите синхронизацию на вкладке «Остатки».`,
        });
      } finally {
        setSyncProgress("");
      }
    } catch (error) {
      toast.error("Загрузка не завершена", { description: error instanceof Error ? error.message : "Повторите попытку." });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="mx-auto grid max-w-[1320px] gap-5 p-4 md:p-7 xl:grid-cols-[0.9fr_1.1fr]">
      <section className="space-y-4">
        <Card className="border-border/80 shadow-[0_8px_24px_rgba(31,38,51,0.04)]">
          <CardHeader className="px-5">
            <div className="flex items-center gap-2">
              <span className="grid size-9 place-items-center rounded-xl bg-[#f0e4c9] text-[#79571b]">
                <UploadCloud className="size-[18px]" />
              </span>
              <div>
                <CardTitle className="text-base">Новая ОСВ</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">Экспортируйте отчет из 1С и загрузите его без изменений</p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 px-5">
            <input ref={inputRef} type="file" accept=".xlsx" className="hidden" onChange={onInputChange} />

            <label className="block space-y-1.5">
              <span className="text-xs font-medium">Дата ОСВ</span>
              <input
                type="date"
                value={balanceDate}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(event) => {
                  setBalanceDate(event.target.value);
                  if (file) void inspectFile(file, event.target.value);
                }}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              />
              <span className="block text-[11px] leading-4 text-muted-foreground">
                На эту дату актуальны остатки в файле. Резерв снимается только с заказов, отгруженных не позже неё.
              </span>
            </label>
            <div
              onDragOver={(event) => event.preventDefault()}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              className="group cursor-pointer rounded-2xl border-2 border-dashed border-[#d3c29c] bg-[#fbf7ed] px-6 py-10 text-center transition hover:border-[#a88645] hover:bg-[#f8f0df]"
            >
              <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-white text-[#88662a] shadow-sm transition group-hover:-translate-y-0.5">
                {parsing ? <Loader2 className="size-5 animate-spin" /> : <FileSpreadsheet className="size-5" />}
              </span>
              <p className="mt-4 text-sm font-semibold">Перетащите файл сюда</p>
              <p className="mt-1 text-xs text-muted-foreground">или нажмите, чтобы выбрать · только XLSX до 12 МБ</p>
            </div>

            {file ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{file.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{formatSize(file.size)}</p>
                </div>
                {preview ? <CheckCircle2 className="size-5 shrink-0 text-emerald-600" /> : previewError ? <AlertCircle className="size-5 shrink-0 text-rose-600" /> : <Loader2 className="size-5 animate-spin text-muted-foreground" />}
              </div>
            ) : null}

            {previewError ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{previewError}</div> : null}

            {preview ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 divide-x divide-y rounded-xl border bg-card py-4 text-center sm:grid-cols-4 sm:divide-y-0">
                  <div><p className="text-xl font-semibold">{preview.articleCount.toLocaleString("ru-RU")}</p><p className="mt-1 text-[11px] text-muted-foreground">артикулов</p></div>
                  <div><p className="text-xl font-semibold">{preview.variantCount.toLocaleString("ru-RU")}</p><p className="mt-1 text-[11px] text-muted-foreground">складских позиций</p></div>
                  <div className="pt-4 sm:pt-0"><p className="text-xl font-semibold">{preview.sizedVariantCount.toLocaleString("ru-RU")}</p><p className="mt-1 text-[11px] text-muted-foreground">строк с размером</p></div>
                  <div className="pt-4 sm:pt-0"><p className="text-xl font-semibold">{preview.totalQuantity.toLocaleString("ru-RU")}</p><p className="mt-1 text-[11px] text-muted-foreground">единиц</p></div>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  Лист «{preview.sheetName}», количество взято из колонки {preview.quantityColumn}, заголовок в строке {preview.headerRowNumber}.
                  Значение <code className="rounded bg-muted px-1 py-0.5">&lt;Пустое субконто4&gt;</code> сохраняется как «Без размера».
                </p>

                {preview.warnings.length ? (
                  <ul className="space-y-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
                    {preview.warnings.map((text) => <li key={text}>{text}</li>)}
                  </ul>
                ) : null}

                {preview.blockers.length ? (
                  <div className="space-y-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-900">
                    <p className="font-semibold">ОСВ не сходится — загрузка заблокирована</p>
                    <ul className="space-y-1">{preview.blockers.map((text) => <li key={text}>{text}</li>)}</ul>
                    <label className="flex items-start gap-2 pt-1">
                      <input
                        type="checkbox"
                        checked={acceptBlockers}
                        onChange={(event) => setAcceptBlockers(event.target.checked)}
                        className="mt-0.5"
                      />
                      <span>Я проверил выгрузку и беру ответственность: загрузить как есть.</span>
                    </label>
                  </div>
                ) : null}

                <div className="rounded-xl border bg-card px-4 py-3 text-xs">
                  <p className="font-semibold">Что изменится</p>
                  <p className="mt-1 text-muted-foreground">
                    Позиций с изменением: {preview.diff.changedCount.toLocaleString("ru-RU")} ·
                    новых: {preview.diff.addedCount.toLocaleString("ru-RU")} ·
                    исчезнет из ОСВ (обнулится): {preview.diff.disappearedCount.toLocaleString("ru-RU")}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    Общий остаток: {preview.diff.quantityBefore.toLocaleString("ru-RU")} → {preview.diff.quantityAfter.toLocaleString("ru-RU")} шт.
                  </p>
                  {preview.diff.topChanges.length ? (
                    <div className="mt-3 max-h-56 overflow-auto">
                      <table className="w-full text-[11px] tabular-nums">
                        <thead className="text-muted-foreground">
                          <tr><th className="text-left font-medium">Артикул</th><th className="text-left font-medium">Размер</th><th className="text-right font-medium">Было</th><th className="text-right font-medium">Станет</th><th className="text-right font-medium">Δ</th></tr>
                        </thead>
                        <tbody>
                          {preview.diff.topChanges.map((change) => (
                            <tr key={change.sourceSku} className="border-t">
                              <td className="py-1">{change.article}</td>
                              <td>{change.size ?? "—"}</td>
                              <td className="text-right">{change.before.toLocaleString("ru-RU")}</td>
                              <td className="text-right">{change.after.toLocaleString("ru-RU")}</td>
                              <td className={`text-right font-medium ${change.delta < 0 ? "text-rose-600" : "text-emerald-700"}`}>
                                {change.delta > 0 ? "+" : ""}{change.delta.toLocaleString("ru-RU")}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : <p className="mt-2 text-muted-foreground">Остатки не изменятся.</p>}
                </div>
              </div>
            ) : null}

            <Button
              className="h-11 w-full"
              disabled={!preview || uploading || (preview.blockers.length > 0 && !acceptBlockers)}
              onClick={upload}
            >
              {uploading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {uploading ? "Обновляем остатки…" : "Загрузить, обновить и синхронизировать"}
            </Button>
            {syncProgress ? (
              <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />{syncProgress}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4">
          <p className="text-sm font-semibold text-emerald-950">Что произойдет после загрузки</p>
          <ol className="mt-3 space-y-2 text-xs leading-5 text-emerald-900">
            <li>1. Сервис сохранит остаток отдельно по каждому сочетанию «артикул + размер».</li>
            <li>2. Закроет резервы уже отгруженных заказов, чтобы не списать товар дважды.</li>
            <li>3. Рассчитает доступный сток и отправит его на каждый активный FBS-склад.</li>
          </ol>
        </div>
      </section>

      <Card className="h-fit border-border/80 shadow-[0_8px_24px_rgba(31,38,51,0.04)]">
        <CardHeader className="px-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <History className="size-4 text-muted-foreground" />
              <CardTitle className="text-base">История загрузок</CardTitle>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void loadHistory()} disabled={historyLoading}>
              <RefreshCw className={historyLoading ? "animate-spin" : ""} />
              Обновить
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-3 sm:px-5">
          {historyLoading ? (
            <div className="grid min-h-48 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Загружаем историю…</div>
          ) : history.length === 0 ? (
            <div className="grid min-h-52 place-items-center rounded-xl border border-dashed text-center">
              <div>
                <FileSpreadsheet className="mx-auto size-7 text-muted-foreground/60" />
                <p className="mt-3 text-sm font-medium">Загрузок пока нет</p>
                <p className="mt-1 text-xs text-muted-foreground">Первая ОСВ появится здесь после обработки</p>
              </div>
            </div>
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>Файл</TableHead><TableHead>Артикулы</TableHead><TableHead>Позиции</TableHead><TableHead>Остаток</TableHead><TableHead>Дата</TableHead><TableHead>Статус</TableHead></TableRow></TableHeader>
              <TableBody>
                {history.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="max-w-52 truncate font-medium">{item.fileName}</TableCell>
                    <TableCell>{item.articleCount.toLocaleString("ru-RU")}</TableCell>
                    <TableCell>{item.skuCount.toLocaleString("ru-RU")}</TableCell>
                    <TableCell>{item.totalQuantity.toLocaleString("ru-RU")}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(item.createdAt)}</TableCell>
                    <TableCell><Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Обработано</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
