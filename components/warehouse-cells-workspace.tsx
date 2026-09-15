/**
 * Ячейки и раскладка.
 *
 * Три вещи на одной странице, потому что кладовщик приходит сюда за ними
 * вместе: найти ячейку по артикулу, посмотреть, что лежит в ячейке, и
 * перенести раскладку из таблицы.
 *
 * Поиск стоит первым: за день его открывают десятки раз, а перенос раскладки —
 * один раз при переезде с Google-таблицы.
 */
"use client";

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

type Cell = { id: number; code: string; sortOrder: number; active: number; placementCount: number };
type Placement = { id: number; article: string; size: string | null; cellCode: string; updatedBy: string | null; updatedAt: string };

type Report = {
  source?: string;
  parsed: number;
  readRows: number;
  skippedHeader: boolean;
  headerRow: number;
  carried: number;
  split: number;
  merged: number;
  duplicates: number;
  swapped?: boolean;
  skipped: { noArticle: number; noCell: number; empty: number };
  errors: Array<{ line: number; message: string }>;
  newCells: number;
  sample?: Array<{ article: string; size: string | null; cell: string }>;
};

type Lookup = { query: string; exact: boolean; byCell?: boolean; matches: Placement[] };

const SOURCE_LABEL: Record<string, string> = { xlsx: "Excel", csv: "CSV", text: "вставка" };

export function WarehouseCellsWorkspace({ canManage }: { canManage: boolean }) {
  const [cells, setCells] = useState<Cell[]>([]);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [total, setTotal] = useState(0);
  const [matched, setMatched] = useState(0);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [lookup, setLookup] = useState<Lookup | null>(null);

  const [pasted, setPasted] = useState("");
  const [replace, setReplace] = useState(false);
  const [carryCellDown, setCarryCellDown] = useState(true);
  const [splitArticles, setSplitArticles] = useState(true);
  const [report, setReport] = useState<Report | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lookupInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async (value: string) => {
    const response = await fetch(`/api/warehouse/cells?search=${encodeURIComponent(value)}&limit=2000`, { cache: "no-store" });
    const data = await response.json() as { cells?: Cell[]; placements?: Placement[]; total?: number; matched?: number; error?: string };
    if (!response.ok) throw new Error(data.error ?? "Не удалось загрузить раскладку.");
    setCells(data.cells ?? []);
    setPlacements(data.placements ?? []);
    setTotal(data.total ?? 0);
    setMatched(data.matched ?? data.placements?.length ?? 0);
  }, []);

  useEffect(() => {
    void Promise.resolve()
      .then(() => load(""))
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Не удалось загрузить раскладку."))
      .finally(() => setLoading(false));
  }, [load]);

  async function runLookup(value: string) {
    const article = value.trim();
    if (!article) {
      setLookup(null);
      return;
    }
    setBusy("lookup");
    try {
      const response = await fetch(`/api/warehouse/cells?lookup=${encodeURIComponent(article)}`, { cache: "no-store" });
      const data = await response.json() as { lookup?: Lookup; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Поиск не сработал.");
      setLookup(data.lookup ?? { query: article, exact: false, matches: [] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Поиск не сработал.");
    } finally {
      setBusy(null);
      lookupInput.current?.select();
    }
  }

  async function runSearch(value: string) {
    setBusy("search");
    try {
      await load(value);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Поиск не сработал.");
    } finally {
      setBusy(null);
    }
  }

  function options() {
    return { carryCellDown, splitArticles };
  }

  async function send(dryRun: boolean, fileOverride?: File) {
    // Файл приходит параметром: состояние обновится только к следующему
    // рендеру, а проверка запускается сразу после выбора файла.
    const file = fileOverride ?? pendingFile;
    if (!file && !pasted.trim()) {
      toast.error("Вставьте столбцы «артикул» и «номер ячейки» или выберите файл.");
      return;
    }
    setBusy(dryRun ? "preview" : "import");
    try {
      let response: Response;
      if (file) {
        const form = new FormData();
        form.set("file", file);
        if (replace) form.set("replace", "1");
        if (dryRun) form.set("dryRun", "1");
        form.set("carryCellDown", carryCellDown ? "1" : "0");
        form.set("splitArticles", splitArticles ? "1" : "0");
        response = await fetch("/api/warehouse/cells/import", { method: "POST", body: form });
      } else {
        response = await fetch("/api/warehouse/cells/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: pasted, replace, dryRun, ...options() }),
        });
      }
      const data = await response.json() as Report & { ok?: boolean; error?: string; placements?: number; cellsCreated?: number; removed?: number; total?: number };
      if (!response.ok) {
        if (typeof data.readRows === "number") setReport(data);
        throw new Error(data.error ?? "Импорт не прошёл.");
      }
      if (dryRun) {
        setReport(data);
        return;
      }
      setReport(data);
      setPasted("");
      setPendingFile(null);
      if (fileInput.current) fileInput.current.value = "";
      toast.success(`Раскладка обновлена: ${data.placements ?? 0} строк`, {
        description: `Ячеек создано: ${data.cellsCreated ?? 0}${data.removed ? `, удалено прежних привязок: ${data.removed}` : ""}`,
      });
      await load(search);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Импорт не прошёл.");
    } finally {
      setBusy(null);
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
      if (lookup) await runLookup(lookup.query);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не сохранилось.");
    } finally {
      setBusy(null);
    }
  }

  const [newArticle, setNewArticle] = useState("");
  const [newSize, setNewSize] = useState("");
  const [newCell, setNewCell] = useState("");
  const [deleteCellTarget, setDeleteCellTarget] = useState<Cell | null>(null);

  if (loading) {
    return <div className="grid min-h-72 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Загружаем раскладку…</div>;
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 md:p-7">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base"><Search className="size-4" /> Где лежит артикул</CardTitle>
          <CardDescription>Введите артикул и нажмите Enter — покажет номер ячейки. Можно ввести и номер ячейки, чтобы увидеть, что в ней лежит.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              ref={lookupInput}
              autoFocus
              placeholder="Артикул"
              className="max-w-sm font-mono"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void runLookup(query); }}
            />
            <Button disabled={busy !== null} onClick={() => void runLookup(query)}>
              {busy === "lookup" ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />} Найти
            </Button>
            {lookup ? (
              <Button variant="ghost" onClick={() => { setLookup(null); setQuery(""); lookupInput.current?.focus(); }}>Сбросить</Button>
            ) : null}
          </div>

          {lookup && lookup.matches.length === 0 ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              <b className="font-mono">{lookup.query}</b> — ни артикула, ни ячейки с таким номером в раскладке нет. Такой артикул попадёт в конец листа подбора без адреса.
              {canManage ? " Можно добавить адрес в блоке «Раскладка» ниже." : ""}
            </div>
          ) : null}

          {lookup && lookup.matches.length > 0 && lookup.byCell ? (
            <div className="space-y-2">
              <p className="text-sm">
                В ячейке <b className="font-mono text-base">{lookup.query}</b> лежит артикулов: <b>{lookup.matches.length}</b>
              </p>
              <div className="flex flex-wrap gap-2 font-mono text-sm">
                {lookup.matches.map((match) => (
                  <span key={match.id} className="rounded border bg-muted/40 px-2 py-1">
                    {match.article}{match.size ? ` · ${match.size}` : ""}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {lookup && lookup.matches.length > 0 && !lookup.byCell ? (
            <div className="space-y-2">
              {!lookup.exact ? (
                <p className="text-xs text-muted-foreground">Точного совпадения нет, показаны похожие артикулы.</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {lookup.matches.map((match) => (
                  <div key={match.id} className="rounded-lg border bg-muted/40 px-4 py-3">
                    <p className="font-mono text-sm">{match.article}{match.size ? ` · размер ${match.size}` : ""}</p>
                    <p className="font-mono text-3xl font-bold leading-tight">{match.cellCode}</p>
                    <p className="text-[11px] text-muted-foreground">изменено {formatMoment(match.updatedAt)}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {canManage ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><Upload className="size-4" /> Перенос раскладки</CardTitle>
            <CardDescription>
              Либо выделите в таблице два столбца — артикул и номер ячейки — и вставьте сюда, либо загрузите файл Excel (.xlsx) или CSV.
              Ячейки, которых ещё нет, создадутся сами; порядок обхода считается из номера.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              rows={6}
              placeholder={"Артикул\tЯчейка\nК-1234\t1\nК-1235\t1\nК-1236\t2"}
              value={pasted}
              onChange={(event) => { setPasted(event.target.value); setReport(null); setPendingFile(null); }}
              className="font-mono text-xs"
              disabled={pendingFile !== null}
            />
            {pendingFile ? (
              <p className="text-sm">
                Файл: <b>{pendingFile.name}</b>{" "}
                <Button variant="ghost" size="sm" onClick={() => { setPendingFile(null); setReport(null); if (fileInput.current) fileInput.current.value = ""; }}>
                  убрать
                </Button>
              </p>
            ) : null}

            <div className="space-y-2">
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <Checkbox checked={carryCellDown} onCheckedChange={(value) => setCarryCellDown(value === true)} />
                <span>
                  Номер ячейки написан один раз на группу артикулов — протянуть его вниз
                  <span className="block text-xs text-muted-foreground">Так выглядят объединённые ячейки в таблице. Без этого вся группа, кроме первой строки, остаётся без адреса.</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <Checkbox checked={splitArticles} onCheckedChange={(value) => setSplitArticles(value === true)} />
                <span>
                  В одном поле перечислено несколько артикулов — разделить
                  <span className="block text-xs text-muted-foreground">Делит по переносу строки и точке с запятой, по запятой — только если в артикулах нет пробелов.</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <Checkbox checked={replace} onCheckedChange={(value) => setReplace(value === true)} />
                <span>
                  Полная замена: удалить прежние привязки и оставить только загруженные
                  <span className="block text-xs text-muted-foreground">Нужна один раз, при переезде с таблицы.</span>
                </span>
              </label>
            </div>

            {report ? (
              <div className="space-y-2 rounded-lg border bg-muted/40 p-3 text-sm">
                <p>
                  Прочитано строк: <b>{report.readRows}</b>, получилось адресов: <b>{report.parsed}</b>, ячеек в них: <b>{report.newCells}</b>
                  {report.source ? ` (${SOURCE_LABEL[report.source] ?? report.source})` : ""}
                  {report.skippedHeader ? `, заголовок в строке ${report.headerRow}` : ", заголовка нет"}
                </p>
                <p className="text-muted-foreground">
                  {report.swapped
                    ? "Столбцы определены по данным: первый — номер ячейки, второй — артикул."
                    : "Столбцы: артикул и номер ячейки — как в заголовке."}
                </p>
                {report.merged > 0 ? <p className="text-muted-foreground">Объединённых ячеек развёрнуто: {report.merged}</p> : null}
                {report.carried > 0 ? <p className="text-muted-foreground">Номер ячейки взят из строки выше: {report.carried} строк</p> : null}
                {report.split > 0 ? <p className="text-muted-foreground">Из полей с несколькими артикулами добавлено строк: {report.split}</p> : null}
                {report.duplicates > 0 ? <p className="text-muted-foreground">Артикул повторялся, оставлен последний адрес: {report.duplicates} раз</p> : null}
                {report.skipped.noCell > 0 ? <p className="text-amber-800">Без номера ячейки пропущено строк: {report.skipped.noCell}</p> : null}
                {report.skipped.noArticle > 0 ? <p className="text-amber-800">Без артикула пропущено строк: {report.skipped.noArticle}</p> : null}
                {report.errors.length > 0 ? (
                  <p className="text-xs text-amber-800">
                    Например: {report.errors.slice(0, 6).map((row) => `строка ${row.line} — ${row.message}`).join("; ")}
                  </p>
                ) : null}
                {report.sample && report.sample.length > 0 ? (
                  <div className="flex flex-wrap gap-2 font-mono text-xs">
                    {report.sample.map((row, index) => (
                      <span key={`${row.article}-${index}`} className="rounded bg-background px-2 py-1">
                        {row.article}{row.size ? `/${row.size}` : ""} → {row.cell}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy !== null} onClick={() => void send(true)}>
                {busy === "preview" ? <Loader2 className="size-4 animate-spin" /> : null} Проверить
              </Button>
              <Button disabled={busy !== null} onClick={() => void send(false)}>
                {busy === "import" ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Загрузить раскладку
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept=".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,text/plain"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  setPendingFile(file);
                  setPasted("");
                  setReport(null);
                  void send(true, file);
                }}
              />
              <Button variant="ghost" disabled={busy !== null} onClick={() => fileInput.current?.click()}>
                Выбрать файл Excel или CSV
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="gap-0 overflow-hidden py-0">
        <div className="space-y-3 border-b px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 font-semibold"><LayoutGrid className="size-4" /> Справочник ячеек и артикулов</p>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">ячеек: {cells.length}</Badge>
              <Badge variant="secondary">строк: {total}</Badge>
            </div>
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="Фильтр: артикул или номер ячейки"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void runSearch(search); }}
            />
            <Button variant="outline" disabled={busy !== null} onClick={() => void runSearch(search)}>
              {busy === "search" ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            </Button>
            {search ? (
              <Button variant="ghost" onClick={() => { setSearch(""); void runSearch(""); }}>Сбросить</Button>
            ) : null}
          </div>
          {canManage ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Ячейка</Label>
                <Input className="w-24" value={newCell} onChange={(event) => setNewCell(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Артикул</Label>
                <Input className="w-44 font-mono" value={newArticle} onChange={(event) => setNewArticle(event.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Размер</Label>
                <Input className="w-24" value={newSize} onChange={(event) => setNewSize(event.target.value)} placeholder="не важен" />
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
          {matched > placements.length ? (
            <p className="text-xs text-muted-foreground">Показано {placements.length} строк из {matched}. Уточните фильтр, чтобы увидеть остальные.</p>
          ) : null}
        </div>
        <div className="max-h-[70vh] overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                <TableHead className="w-24 pl-5">Ячейка</TableHead>
                <TableHead>Артикул</TableHead>
                {canManage ? <TableHead className="w-12 pr-5" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {placements.map((placement) => (
                <TableRow key={placement.id}>
                  <TableCell className="pl-5 font-mono text-sm font-semibold">{placement.cellCode}</TableCell>
                  <TableCell className="font-mono text-sm">
                    {placement.article}
                    {placement.size ? <span className="ml-2 text-xs text-muted-foreground">размер {placement.size}</span> : null}
                  </TableCell>
                  {canManage ? (
                    <TableCell className="pr-5 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => void post({ action: "delete_placement", id: placement.id }, "Строка удалена")}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
              {placements.length === 0 ? (
                <TableRow><TableCell colSpan={canManage ? 3 : 2} className="h-24 text-center text-muted-foreground">Ничего не найдено.</TableCell></TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </Card>

      {canManage && cells.length > 0 ? (
        <details className="rounded-xl border bg-card px-5 py-4 text-sm">
          <summary className="cursor-pointer font-semibold">Список ячеек и сколько в каждой артикулов</summary>
          <div className="mt-3 flex flex-wrap gap-2">
            {cells.map((cell) => (
              <span key={cell.id} className="inline-flex items-center gap-2 rounded border px-2 py-1">
                <button
                  type="button"
                  className="font-mono font-semibold hover:underline"
                  onClick={() => { setQuery(cell.code); void runLookup(cell.code); }}
                >
                  {cell.code}
                </button>
                <span className="text-xs text-muted-foreground">{cell.placementCount}</span>
                <button
                  type="button"
                  className="text-destructive"
                  title="Удалить ячейку"
                  onClick={() => setDeleteCellTarget(cell)}
                >
                  <Trash2 className="size-3" />
                </button>
              </span>
            ))}
          </div>
        </details>
      ) : null}


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
