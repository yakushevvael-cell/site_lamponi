"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Copy, Crown, KeyRound, Loader2, Shield, ShieldCheck, UserRoundX } from "lucide-react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type UserRole = "admin" | "manager" | "user";
type AccessLevel = "simple" | "full" | "owner";
type UserRow = {
  email: string;
  fullName: string | null;
  role: UserRole;
  status: "pending" | "active" | "blocked";
  createdAt: string;
  approvedAt: string | null;
};

const statusLabel = { pending: "Ожидает", active: "Активен", blocked: "Заблокирован" } as const;

function displayName(user: UserRow) {
  return user.fullName || user.email;
}

function roleLabel(role: UserRole) {
  if (role === "admin") return "Владелец";
  if (role === "manager") return "Полный доступ";
  return "Простой доступ";
}

function RoleBadge({ user }: { user: UserRow }) {
  if (user.status === "pending") return <Badge variant="secondary">Права не назначены</Badge>;
  if (user.role === "admin") return <Badge>Владелец</Badge>;
  if (user.role === "manager") return <Badge className="bg-violet-100 text-violet-800 hover:bg-violet-100">Полный доступ</Badge>;
  return <Badge variant="outline">Простой доступ</Badge>;
}

export function UsersWorkspace() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [fullAccessTarget, setFullAccessTarget] = useState<UserRow | null>(null);
  const [ownerTarget, setOwnerTarget] = useState<UserRow | null>(null);
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [issuedPassword, setIssuedPassword] = useState<{ email: string; password: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/users", { cache: "no-store" });
      const result = await response.json() as { users?: UserRow[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось загрузить пользователей.");
      setUsers(result.users ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось загрузить пользователей.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  async function update(
    email: string,
    action: "approve" | "block" | "set_role",
    successMessage: string,
    accessLevel?: AccessLevel,
  ) {
    setBusyEmail(email);
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, action, accessLevel }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Не удалось изменить доступ.");
      toast.success(successMessage);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось изменить доступ.");
    } finally {
      setBusyEmail(null);
    }
  }

  // Сброс пароля: сервер возвращает временный пароль один раз, показываем его
  // администратору и нигде не сохраняем — в базе лежит только хеш.
  async function resetPassword(user: UserRow) {
    setBusyEmail(user.email);
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, action: "reset_password" }),
      });
      const result = await response.json() as { temporaryPassword?: string; error?: string };
      if (!response.ok || !result.temporaryPassword) throw new Error(result.error ?? "Не удалось сбросить пароль.");
      setIssuedPassword({ email: user.email, password: result.temporaryPassword });
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось сбросить пароль.");
    } finally {
      setBusyEmail(null);
    }
  }

  function requestFullAccess(user: UserRow) {
    setFullAccessTarget(user);
  }

  function RightsMenu({ user }: { user: UserRow }) {
    const value: AccessLevel = user.role === "admin" ? "owner" : user.role === "manager" ? "full" : "simple";
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" disabled={busyEmail === user.email}>
            {busyEmail === user.email ? <Loader2 className="size-4 animate-spin" /> : <Shield className="size-4" />}
            Права: {roleLabel(user.role)} <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel>Уровень доступа</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(nextValue) => {
              if (nextValue === value) return;
              if (nextValue === "owner") setOwnerTarget(user);
              else if (nextValue === "full") requestFullAccess(user);
              else void update(user.email, "set_role", "Установлен простой доступ", "simple");
            }}
          >
            <DropdownMenuRadioItem value="simple">Простой — ОСВ, просмотр, обнуление</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="full">Полный — все права администратора</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="owner">Владелец — полный доступ, нельзя заблокировать</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <section className="p-4 sm:p-6 lg:p-8">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5" /> Доступ к Lamponi Hub</CardTitle>
          <CardDescription>Разрешите регистрацию по e-mail и сразу назначьте один из двух уровней прав. Владелец защищён от блокировки и изменения роли.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border bg-muted/35 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold"><Shield className="size-4" /> Простой доступ</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">Просмотр данных, загрузка ОСВ, ручное обнуление и снятие обнуления выбранных остатков.</p>
            </div>
            <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-violet-950"><ShieldCheck className="size-4" /> Полный доступ</p>
              <p className="mt-1 text-xs leading-5 text-violet-800">Все функции простого доступа, управление пользователями и подключениями, обновление заказов и полная синхронизация остатков.</p>
            </div>
          </div>

          {loading ? (
            <div className="grid min-h-52 place-items-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Пользователь</TableHead>
                    <TableHead>Права</TableHead>
                    <TableHead>Статус</TableHead>
                    <TableHead>Регистрация</TableHead>
                    <TableHead className="text-right">Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user) => (
                    <TableRow key={user.email}>
                      <TableCell><p className="font-medium">{user.fullName || "Без имени"}</p><p className="text-xs text-muted-foreground">{user.email}</p></TableCell>
                      <TableCell><RoleBadge user={user} /></TableCell>
                      <TableCell><Badge variant={user.status === "active" ? "outline" : user.status === "pending" ? "secondary" : "destructive"}>{statusLabel[user.status]}</Badge></TableCell>
                      <TableCell className="text-sm text-muted-foreground">{new Date(user.createdAt).toLocaleString("ru-RU")}</TableCell>
                      <TableCell>
                        <div className="flex min-w-max flex-wrap justify-end gap-2">
                          {user.role === "admin" ? <span className="self-center text-xs text-muted-foreground">Владелец</span> : null}
                          {user.role !== "admin" && user.status === "pending" ? (
                            <>
                              <Button size="sm" variant="outline" disabled={busyEmail === user.email} onClick={() => void update(user.email, "approve", "Регистрация разрешена: простой доступ", "simple")}>
                                {busyEmail === user.email ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Разрешить: простой
                              </Button>
                              <Button size="sm" disabled={busyEmail === user.email} onClick={() => requestFullAccess(user)}><ShieldCheck className="size-4" /> Разрешить: полный</Button>
                              <Button size="sm" variant="outline" disabled={busyEmail === user.email} onClick={() => setOwnerTarget(user)}><Crown className="size-4" /> Назначить владельцем</Button>
                            </>
                          ) : null}
                          {user.role !== "admin" && user.status !== "pending" ? <RightsMenu user={user} /> : null}
                          {user.role !== "admin" && user.status === "blocked" ? (
                            <Button size="sm" disabled={busyEmail === user.email} onClick={() => void update(user.email, "approve", "Доступ восстановлен")}>
                              {busyEmail === user.email ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Разблокировать
                            </Button>
                          ) : null}
                          {user.role !== "admin" && user.status === "active" ? (
                            <AlertDialog>
                              <AlertDialogTrigger asChild><Button size="sm" variant="outline" className="text-destructive hover:text-destructive" disabled={busyEmail === user.email}><UserRoundX className="size-4" /> Заблокировать</Button></AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader><AlertDialogTitle>Заблокировать пользователя?</AlertDialogTitle><AlertDialogDescription>{displayName(user)} потеряет доступ к Lamponi Hub. Назначенный уровень прав сохранится и будет восстановлен после разблокировки.</AlertDialogDescription></AlertDialogHeader>
                                <AlertDialogFooter><AlertDialogCancel>Отмена</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void update(user.email, "block", "Пользователь заблокирован")}>Заблокировать</AlertDialogAction></AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          ) : null}
                          <Button size="sm" variant="outline" disabled={busyEmail === user.email} onClick={() => setResetTarget(user)}>
                            {busyEmail === user.email ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />} Сбросить пароль
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {users.length === 0 ? <TableRow><TableCell colSpan={5} className="h-32 text-center text-muted-foreground">Пользователей пока нет</TableCell></TableRow> : null}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={Boolean(fullAccessTarget)} onOpenChange={(open) => { if (!open) setFullAccessTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Выдать полный доступ?</AlertDialogTitle>
            <AlertDialogDescription>{fullAccessTarget ? displayName(fullAccessTarget) : "Пользователь"} получит права администратора: сможет управлять пользователями, подключениями маркетплейсов и запускать полную синхронизацию остатков.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              if (!fullAccessTarget) return;
              const user = fullAccessTarget;
              setFullAccessTarget(null);
              void update(user.email, user.status === "pending" ? "approve" : "set_role", user.status === "pending" ? "Регистрация разрешена: полный доступ" : "Выдан полный доступ", "full");
            }}>Выдать полный доступ</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(ownerTarget)} onOpenChange={(open) => { if (!open) setOwnerTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Назначить владельцем?</AlertDialogTitle>
            <AlertDialogDescription>
              {ownerTarget ? displayName(ownerTarget) : "Пользователь"} получит права владельца: все функции полного доступа,
              а также защиту от блокировки и от изменения прав. Снять права владельца через интерфейс нельзя — только через базу данных.
              Владельцев может быть несколько.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              if (!ownerTarget) return;
              const user = ownerTarget;
              setOwnerTarget(null);
              void update(
                user.email,
                user.status === "pending" ? "approve" : "set_role",
                user.status === "pending" ? "Регистрация разрешена: владелец" : "Назначен владельцем",
                "owner",
              );
            }}>Назначить владельцем</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(resetTarget)} onOpenChange={(open) => { if (!open) setResetTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Сбросить пароль?</AlertDialogTitle>
            <AlertDialogDescription>
              {resetTarget ? displayName(resetTarget) : "Пользователь"} получит временный пароль — он будет показан здесь один раз.
              Все текущие сеансы этого пользователя завершатся, а при первом входе система попросит задать новый пароль.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              if (!resetTarget) return;
              const user = resetTarget;
              setResetTarget(null);
              void resetPassword(user);
            }}>Сбросить пароль</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(issuedPassword)} onOpenChange={(open) => { if (!open) setIssuedPassword(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Временный пароль</AlertDialogTitle>
            <AlertDialogDescription>
              Пароль для {issuedPassword?.email}. Он показывается один раз — скопируйте и передайте сотруднику лично.
              При первом входе система попросит сменить его.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3">
            <code className="flex-1 break-all font-mono text-base">{issuedPassword?.password}</code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (!issuedPassword) return;
                void navigator.clipboard.writeText(issuedPassword.password)
                  .then(() => toast.success("Пароль скопирован"))
                  .catch(() => toast.error("Не удалось скопировать — выделите пароль вручную."));
              }}
            >
              <Copy className="size-4" /> Копировать
            </Button>
          </div>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setIssuedPassword(null)}>Готово</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
