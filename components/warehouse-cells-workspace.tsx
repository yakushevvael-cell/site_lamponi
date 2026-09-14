"use client";

/**
 * Ячейки и раскладка «артикул → ячейка».
 *
 * Перенос из Google-таблицы сделан вставкой двух столбцов: это быстрее и
 * надёжнее выгрузки в файл, а формат разбирается сам. После переноса раскладку
 * из таблицы нужно убрать — два источника правды о месте товара дают пересорт.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutGrid, Loader2, Plus, Search, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatMoment } from "@/lib/utils";

type Cell = { id: number; code: string; zone: string | null; sortOrder: number; active: number; placementCount: number };
type Placement = { id: number; article: string; size: string | null; cellCode: string; updatedBy: string | null; updatedAt: string };
type Preview = { parsed: number; newCells: number; skippedHeader: boolean; sample: Array<{ article: string; size: string | null; cell: string }>; errors: Array<{ line: number; message: string }> };

export function WarehouseCellsWorkspace({ canManage }: { canManage: boolean }) {
  const [cells, setCells] = useState<Cell[]>([]);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const [pasted, setPasted] = useState("");
  const [replace, setReplace] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [newArticle, setNewArticle] = useState("");
  const [newSize, setNewSize] = useState("");
  const [newCell, setNewCell] = useState("");
  const [deleteCellTarget, setDeleteCellTarget] = useState<Cell | null>(null);

  const load = useCallback(async (query: string) => {
    const response = await fetch(`/api/warehouse/cells?search=${encodeURIComponent(query)}&limit=200`, { cache: "no-store" });
    const data = await response.json() as { cells?: Cell[]; placements?: Placement[]; total?: number; error?: string };
    if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить раскладку.");
    setCells(data.cells ?? []);
    setPlacements(data.placements ?? []);
    setTotal(data.total ?? 0);
  }, []);

  useEffect(() => {
    void Promise.resolve()
      .then(() => load(""))
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Не удалось загрузить раскладку."))
      .finally(() => setLoading(false));
  }, [load]);

  async function runSearch(query: string) {
    setBusy("search");
    try {
      await load(query);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Поиск не сработал.");
    } finally {
      setBusy(null);
    }
  }

  async function importText(dryRun: boolean) {
    if (!pasted.trim()) {
      toast.error("Вставьте два столбца: артикул и ячейка.");
      return;
    }
    setBusy(dryRun ? "preview" : "import");
    try {
      const response = await fetch("/api/warehouse/cells/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: pasted, replace, dryRun }),
      });
      const data = await response.json() as Preview & { ok?: boolean; error?: string; placements?: number; cellsCreated?: number; removed?: number };
      if (!response.ok) throw new Error(data.error ?? "Импорт не прошёл.");
      if (dryRun) {
        setPreview(data);
        return;
      }
      setPreview(null);
      setPasted("");
      toast.success(`Раскладка обновлена: ${data.placements ?? 0} строк`, {
        description: `Новых ячеек: ${data.cellsCreated ?? 0}${data.removed ? `, удалено прежних привязок: ${data.removed}` : ""}`,
      });
      await load(search);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Импорт не прошёл.");
    } finally {
      setBusy(null);
    }
  }

  async function importFile(file: File) {
    setBusy("import");
    try {
      const form = new FormData();
      form.set("file", file);
      if (replace) form.set("replace", "1");
      const response = await fetch("/api/warehouse/cells/import", { method: "POST", body: form });
      const data = await response.json() as { placements?: number; cellsCreated?: number; removed?: number; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Файл не разобрался.");
      toast.success(`Раскладка обновлена: ${data.placements ?? 0} строк`, {
        description: `Новых ячеек: ${data.cellsCreated ?? 0}${data.removed ? `, удалено прежних привязок: ${data.removed}` : ""}`,
      });
      await load(search);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Файл не разобрался.");
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function post(payload: Record<string, unknown>, message: string) {
    setBusy(String(payload.action));
    try {
      const response = await fetch("/api/warehouse/cells", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json() as { error?: string; removedPlacements?: number };
      if (!response.ok) throw new Error(data.error ?? "Не сохранилось.");
      toast.success(message, {
        description: data.removedPlacements ? `Артикулов осталось без адреса: ${data.removedPlacements}` : undefined,
      });
      await load(search);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не сохранилось.");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return <div className="grid min-h-72 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Загружаем раскладку…</div>;
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 md:p-7">
      {canManage ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><Upload className="size-4" /> Перенос раскладки из Google-таблицы</CardTitle>
            <CardDescription>
              Выделите в таблице два столбца — артикул и ячейку — и вставьте сюда (можно с заголовком и со столбцом размера).
              Либо загрузите CSV. Ячейки, которых ещё нет, создадутся сами, порядок обхода посчитается из кода ячейки.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              rows={6}
              placeholder={"Артикул\tЯчейка\nК-1234\tA-01-05\nК-1235\tA-01-06"}
              value={pasted}
              onChange={(event) => { setPasted(event.target.value); setPreview(null); }}
              className="font-mono text-xs"
            />
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={replace} onCheckedChange={(value) => setReplace(value === true)} />
              Полная замена: удалить прежние привязки и оставить только вставленные
            </label>
            {preview ? (
              <div className="space-y-2 rounded-lg border bg-muted/40 p-3 text-sm">
                <p>
                  Разобрано строк: <b>{preview.parsed}</b>, ячеек в них: <b>{preview.newCells}</b>
                  {preview.skippedHeader ? ", первая строка принята за заголовок" : ""}
                </p>
                {preview.errors.length > 0 ? (
                  <p className="text-amber-800">Пропущено строк: {preview.errors.length} (например, строка {preview.errors[0]?.line}: {preview.errors[0]?.message})</p>
                ) : null}
                <div className="flex flex-wrap gap-2 font-mono text-xs">
                  {preview.sample.map((row, index) => (
                    <span key={`${row.article}-${index}`} className="rounded bg-background px-2 py-1">
                      {row.article}{row.size ? `/${row.size}` : ""} → {row.cell}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy !== null} onClick={() => void importText(true)}>
                {busy === "preview" ? <Loader2 className="size-4 animate-spin" /> : null} Проверить
              </Button>
              <Button disabled={busy !== null} onClick={() => void importText(false)}>
                {busy === "import" ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Загрузить раскладку
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importFile(file);
                }}
              />
              <Button variant="ghost" disabled={busy !== null} onClick={() => fileInput.current?.click()}>
                Загрузить файлом CSV
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-[1fr_1.4fr]">
        <Card className="gap-0 overflow-hidden py-0">
          <div className="flex items-center justify-between gap-2 border-b px-5 py-4">
            <p className="flex items-center gap-2 font-semibold"><LayoutGrid className="size-4" /> Ячейки</p>
            <Badge variant="secondary">{cells.length}</Badge>
          </div>
          <div className="max-h-[520px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Код</TableHead>
                  <TableHead>Зона</TableHead>
                  <TableHead className="text-right">Порядок</TableHead>
                  <TableHead className="text-right">Артикулов</TableHead>
                  {canManage ? <TableHead className="pr-5" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {cells.map((cell) => (
                  <TableRow key={cell.id}>
                    <TableCell className="pl-5 font-mono text-sm font-semibold">
                      {cell.code}
                      {cell.active ? null : <Badge variant="outline" className="ml-2 text-[10px]">выключена</Badge>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{cell.zone ?? "—"}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">{cell.sortOrder}</TableCell>
                    <TableCell className="text-right text-sm">{cell.placementCount}</TableCell>
                    {canManage ? (
                      <TableCell className="pr-5 text-right">
                        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleteCellTarget(cell)}>
                          <Trash2 className="size-4" />
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
                {cells.length === 0 ? (
                  <TableRow><TableCell colSpan={canManage ? 5 : 4} className="h-24 text-center text-muted-foreground">Ячеек пока нет.</TableCell></TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </Card>

        <Card className="gap-0 overflow-hidden py-0">
          <div className="space-y-3 border-b px-5 py-4">
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold">Раскладка</p>
              <Badge variant="secondary">{total} привязок</Badge>
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="Артикул или ячейка"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void runSearch(search); }}
              />
              <Button variant="outline" disabled={busy !== null} onClick={() => void runSearch(search)}>
                {busy === "search" ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              </Button>
            </div>
            {canManage ? (
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Артикул</Label>
                  <Input className="w-40" value={newArticle} onChange={(event) => setNewArticle(event.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Размер</Label>
                  <Input className="w-24" value={newSize} onChange={(event) => setNewSize(event.target.value)} placeholder="не важен" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Ячейка</Label>
                  <Input className="w-32" value={newCell} onChange={(event) => setNewCell(event.target.value)} />
                </div>
                <Button
                  variant="outline"
                  disabled={busy !== null || !newArticle.trim() || !newCell.trim()}
                  onClick={() => {
                    void post(
                      { action: "set_placement", article: newArticle.trim(), size: newSize.trim() || null, cell: newCell.trim() },
                      "Адрес сохранён",
                    ).then(() => { setNewArticle(""); setNewSize(""); setNewCell(""); });
                  }}
                >
                  <Plus className="size-4" /> Добавить
                </Button>
              </div>
            ) : null}
          </div>
          <div className="max-h-[520px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Артикул</TableHead>
                  <TableHead>Размер</TableHead>
                  <TableHead>Ячейка</TableHead>
                  <TableHead>Изменено</TableHead>
                  {canManage ? <TableHead className="pr-5" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {placements.map((placement) => (
                  <TableRow key={placement.id}>
                    <TableCell className="pl-5 font-mono text-sm">{placement.article}</TableCell>
                    <TableCell className="text-sm">{placement.size ?? "—"}</TableCell>
                    <TableCell className="font-mono text-sm font-semibold">{placement.cellCode}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatMoment(placement.updatedAt)}
                      {placement.updatedBy ? <span className="block">{placement.updatedBy}</span> : null}
                    </TableCell>
                    {canManage ? (
                      <TableCell className="pr-5 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => void post({ action: "delete_placement", id: placement.id }, "Привязка удалена")}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
                {placements.length === 0 ? (
                  <TableRow><TableCell colSpan={canManage ? 5 : 4} className="h-24 text-center text-muted-foreground">Ничего не найдено.</TableCell></TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </Card>
      </section>

      <AlertDialog open={Boolean(deleteCellTarget)} onOpenChange={(open) => { if (!open) setDeleteCellTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить ячейку {deleteCellTarget?.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              Вместе с ячейкой пропадут адреса {deleteCellTarget?.placementCount ?? 0} артикулов — в заданиях они окажутся без ячейки,
              в конце списка. Сами задания и остатки не меняются.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const cell = deleteCellTarget;
                setDeleteCellTarget(null);
                if (cell) void post({ action: "delete_cell", id: cell.id }, "Ячейка удалена");
              }}
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
