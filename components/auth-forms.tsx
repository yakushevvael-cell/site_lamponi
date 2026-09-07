"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, DatabaseZap, KeyRound, Loader2, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function Shell({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <main className="grid min-h-svh place-items-center bg-muted/35 p-6">
      <Card className="w-full max-w-md border-border/70 shadow-xl shadow-black/5">
        <CardHeader className="space-y-5 text-center">
          <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
            <DatabaseZap className="size-7" />
          </span>
          <div className="space-y-2">
            <CardTitle className="text-2xl">{title}</CardTitle>
            <CardDescription className="text-sm leading-6">{description}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
      </Card>
    </main>
  );
}

function ErrorNote({ text }: { text: string }) {
  if (!text) return null;
  return <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{text}</p>;
}

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json() as { error?: string; mustChangePassword?: boolean; pending?: boolean };
      if (!response.ok) throw new Error(data.error ?? "Не удалось войти.");
      if (data.mustChangePassword) router.push("/password");
      else if (data.pending) router.push("/access-pending");
      else router.push(next);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось войти.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title="Вход в Lamponi Hub" description="Введите почту и пароль, чтобы открыть остатки, заказы и склады.">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Почта</Label>
          <Input id="email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@lamponi.store" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Пароль</Label>
          <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
        </div>
        <ErrorNote text={error} />
        <Button type="submit" size="lg" className="w-full" disabled={busy || !email || !password}>
          {busy ? <Loader2 className="animate-spin" /> : <ArrowRight className="size-4" />}
          Войти
        </Button>
      </form>
      <p className="text-center text-xs text-muted-foreground">
        Нет доступа? <Link href="/register" className="underline">Зарегистрироваться</Link> — администратор подтвердит его вручную.
      </p>
      <p className="flex items-center justify-center gap-2 text-center text-xs text-muted-foreground">
        <ShieldCheck className="size-4 text-emerald-600" />
        Пароль забыт — его сбрасывает администратор на вкладке «Пользователи»
      </p>
    </Shell>
  );
}

export function RegisterForm({ firstUser }: { firstUser: boolean }) {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== repeat) {
      setError("Пароли не совпадают.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, fullName, phone }),
      });
      const data = await response.json() as { error?: string; status?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось зарегистрироваться.");
      router.push(data.status === "active" ? "/" : "/access-pending");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось зарегистрироваться.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell
      title={firstUser ? "Создание аккаунта администратора" : "Регистрация"}
      description={firstUser
        ? "В системе ещё нет пользователей. Этот аккаунт станет администратором с полным доступом."
        : "Заполните данные — доступ откроет администратор."}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="fullName">Имя и фамилия</Label>
          <Input id="fullName" required value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Иван Петров" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="reg-email">Почта</Label>
          <Input id="reg-email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">Телефон <span className="text-muted-foreground">— необязательно</span></Label>
          <Input id="phone" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+7 900 000-00-00" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="reg-password">Пароль</Label>
          <Input id="reg-password" type="password" autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          <p className="text-[11px] text-muted-foreground">Не короче 10 символов. Лучше короткая фраза, чем короткий набор знаков.</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="repeat">Пароль ещё раз</Label>
          <Input id="repeat" type="password" autoComplete="new-password" required value={repeat} onChange={(event) => setRepeat(event.target.value)} />
        </div>
        <ErrorNote text={error} />
        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <ArrowRight className="size-4" />}
          Зарегистрироваться
        </Button>
      </form>
      <p className="text-center text-xs text-muted-foreground">
        Уже есть доступ? <Link href="/login" className="underline">Войти</Link>
      </p>
    </Shell>
  );
}

export function ChangePasswordForm({ forced }: { forced: boolean }) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== repeat) {
      setError("Новые пароли не совпадают.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Не удалось сменить пароль.");
      setDone(true);
      router.push("/");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось сменить пароль.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell
      title="Смена пароля"
      description={forced
        ? "Вы вошли по временному паролю. Придумайте постоянный, чтобы продолжить."
        : "Придумайте новый пароль. Все текущие сессии будут завершены."}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="current">Текущий пароль</Label>
          <Input id="current" type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="new">Новый пароль</Label>
          <Input id="new" type="password" autoComplete="new-password" required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="new-repeat">Новый пароль ещё раз</Label>
          <Input id="new-repeat" type="password" autoComplete="new-password" required value={repeat} onChange={(event) => setRepeat(event.target.value)} />
        </div>
        <ErrorNote text={error} />
        <Button type="submit" size="lg" className="w-full" disabled={busy || done}>
          {busy ? <Loader2 className="animate-spin" /> : <KeyRound className="size-4" />}
          Сохранить пароль
        </Button>
      </form>
    </Shell>
  );
}
