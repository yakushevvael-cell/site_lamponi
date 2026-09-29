"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, Copy, KeyRound, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type OnecStatus = {
  key: { hint: string; createdBy: string | null; createdAt: string; lastUsedAt: string | null } | null;
  tasksSince: string | null;
  registry: { count: number; updatedAt: string | null; lastUpload: { acceptedCount: number; createdAt: string } | null };
  tasks: { ok: number; failed: number; errors: Array<{ taskId: number; taskNumber: string | null; message: string | null; updatedAt: string }> };
};

/** Время из SQLite (UTC без зоны) и из JS (ISO) — показываем в местном. */
function when(value: string | null | undefined) {
  if (!value) return "не было";
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ru-RU");
}

/**
 * Обмен с 1С: ключ для внешней обработки «ОбменFBSLamponi» и то, как идёт обмен.
 * Ключ показывается один раз — сайт хранит только его хеш.
 */
export function OnecConnectionCard() {
  const [status, setStatus] = useState<OnecStatus | null>(null);
  const [busy, setBusy] = useState<"issue" | "revoke" | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/integrations/onec", { cache: "no-store" });
    if (response.ok) setStatus(await response.json() as OnecStatus);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function issue() {
    setBusy("issue"); setConfirmReplace(false);
    try {
      const response = await fetch("/api/integrations/onec", { method: "POST" });
      const data = await response.json() as { token?: string; error?: string };
      if (!response.ok || !data.token) throw new Error(data.error ?? "Ключ не выпущен.");
      setToken(data.token);
      await load();
    } catch (error) {
      toast.error("Ключ не выпущен", { description: error instanceof Error ? error.message : "Повторите попытку." });
    } finally { setBusy(null); }
  }

  async function revoke() {
    setBusy("revoke");
    try {
      const response = await fetch("/api/integrations/onec", { method: "DELETE" });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? "Ключ не отозван.");
      toast.success("Ключ 1С отозван", { description: "Обмен остановится при следующем запросе 1С." });
      await load();
    } catch (error) {
      toast.error("Ключ не отозван", { description: error instanceof Error ? error.message : "Повторите попытку." });
    } finally { setBusy(null); }
  }

  async function copy() {
    if (!token) return;
    try { await navigator.clipboard.writeText(token); toast.success("Ключ скопирован"); }
    catch { toast.error("Не удалось скопировать — выделите ключ и скопируйте вручную."); }
  }

  const key = status?.key ?? null;
  const connected = Boolean(key?.lastUsedAt);

  return <Card>
    <CardHeader className="px-5">
      <div className="flex items-start justify-between">
        <span className="grid size-11 place-items-center rounded-xl bg-red-600 text-xs font-bold text-white">1С</span>
        <Badge className={connected ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100" : key ? "bg-amber-100 text-amber-800 hover:bg-amber-100" : "bg-muted text-muted-foreground hover:bg-muted"}>
          {connected ? <CheckCircle2 /> : <CircleDashed />}{connected ? "1С на связи" : key ? "Ключ выпущен" : "Нет ключа"}
        </Badge>
      </div>
      <CardTitle className="mt-3 text-base">1С «Ювелирное производство»</CardTitle>
      <p className="text-xs leading-5 text-muted-foreground">Обработка «ОбменFBSLamponi» сама забирает задания для черновиков «Расход ГП» и присылает регистр ШК → УИН. Ключ вводится в её настройках.</p>
    </CardHeader>
    <CardContent className="space-y-3 px-5">
      <div className="grid gap-2 rounded-xl bg-muted p-3 text-xs sm:grid-cols-3">
        <div>
          <p>Ключ: <b>{key ? `…${key.hint}` : "нет"}</b></p>
          <p className="mt-1 text-muted-foreground">Выпущен: {when(key?.createdAt)}</p>
          <p className="mt-1 text-muted-foreground">Последний запрос 1С: {when(key?.lastUsedAt)}</p>
        </div>
        <div>
          <p>ШК в регистре: <b>{status?.registry.count ?? 0}</b></p>
          <p className="mt-1 text-muted-foreground">Последняя выгрузка из 1С: {when(status?.registry.lastUpload?.createdAt)}{status?.registry.lastUpload ? `, строк ${status.registry.lastUpload.acceptedCount}` : ""}</p>
        </div>
        <div>
          <p>Документов «Расход ГП»: <b>{status?.tasks.ok ?? 0}</b>{status?.tasks.failed ? <>, с ошибкой <b className="text-destructive">{status.tasks.failed}</b></> : null}</p>
          <p className="mt-1 text-muted-foreground">Задания уходят в 1С с {when(status?.tasksSince)}</p>
        </div>
      </div>

      {status?.tasks.errors.length ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
        <p className="flex items-center gap-2 font-semibold"><TriangleAlert className="size-4" />1С не смогла обработать задания</p>
        <ul className="mt-2 space-y-1">{status.tasks.errors.map((error) => <li key={error.taskId}><b>{error.taskNumber ?? `#${error.taskId}`}</b>: {error.message ?? "без описания"} <span className="text-amber-800/70">({when(error.updatedAt)})</span></li>)}</ul>
      </div> : null}

      <div className="grid gap-2 sm:grid-cols-2">
        <Button disabled={busy !== null} onClick={() => key ? setConfirmReplace(true) : void issue()}>
          {busy === "issue" ? <Loader2 className="animate-spin" /> : <KeyRound />}{key ? "Выпустить новый ключ" : "Выпустить ключ для 1С"}
        </Button>
        {key ? <Button variant="outline" className="text-destructive" disabled={busy !== null} onClick={() => void revoke()}>
          {busy === "revoke" ? <Loader2 className="animate-spin" /> : <KeyRound />}Отозвать ключ
        </Button> : null}
      </div>
    </CardContent>

    <Dialog open={confirmReplace} onOpenChange={setConfirmReplace}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Выпустить новый ключ?</DialogTitle>
          <DialogDescription>Текущий ключ …{key?.hint} перестанет работать сразу. Обмен с 1С остановится, пока новый ключ не введут в настройках обработки.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmReplace(false)}>Отмена</Button>
          <Button onClick={() => void issue()}>Выпустить новый</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={token !== null} onOpenChange={(open) => { if (!open) setToken(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ключ обмена с 1С</DialogTitle>
          <DialogDescription>Скопируйте ключ и передайте программисту 1С: он вводится в поле «Токен обмена» в настройках обработки. После закрытия окна ключ больше не покажется — если он потеряется, выпустите новый.</DialogDescription>
        </DialogHeader>
        <Input readOnly value={token ?? ""} className="font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
        <DialogFooter>
          <Button variant="outline" onClick={() => void copy()}><Copy />Скопировать</Button>
          <Button onClick={() => setToken(null)}>Готово</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Card>;
}
