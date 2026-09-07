import { timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getRuntimeEnv } from "@/lib/runtime-env";
import { getSessionUser } from "@/lib/session";

export type AppRole = "admin" | "manager" | "user";

export type AppUser = {
  email: string;
  fullName: string | null;
  role: AppRole;
  status: "pending" | "active" | "blocked";
  createdAt: string;
};

/**
 * ТЗ, п. 13: обновлять список складов, включать и отключать выгрузку,
 * запускать полную синхронизацию и управлять ключами может ТОЛЬКО администратор.
 * Менеджер видит склады и статусы, но ничего не отправляет на маркетплейсы.
 */
export function hasAdminAccess(user: Pick<AppUser, "role">) {
  return user.role === "admin";
}

/** Расширенный просмотр (аналитика, журнал) — администратор и менеджер. */
export function hasManagerAccess(user: Pick<AppUser, "role">) {
  return user.role === "admin" || user.role === "manager";
}

/**
 * Текущий пользователь.
 *
 * Раньше личность приходила заголовком от платформы OpenAI («вход через
 * ChatGPT»). Теперь её подтверждает собственная сессия: cookie → app_sessions.
 */
export async function getAppUser(): Promise<AppUser | null> {
  const session = await getSessionUser();
  if (!session) return null;
  return {
    email: session.email,
    fullName: session.fullName,
    role: session.role,
    status: session.status,
    createdAt: session.createdAt,
  };
}

/** Есть ли в системе хоть один пользователь: первый регистрирующийся станет админом. */
export async function hasAnyUser() {
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return true;
  const row = await runtime.DB.prepare("SELECT COUNT(*) AS count FROM app_users").first<{ count: number }>();
  return Number(row?.count ?? 0) > 0;
}

export async function requirePageUser(returnTo: string, adminOnly = false): Promise<AppUser> {
  const user = await getAppUser();
  if (!user) redirect(loginPath(returnTo));
  if (user.status !== "active") redirect("/access-pending");
  // Временный пароль, выданный администратором, надо сменить до работы с данными.
  if (await mustChangePassword(user.email)) redirect("/password");
  if (adminOnly && !hasAdminAccess(user)) redirect("/");
  return user;
}

/** Выдан ли пользователю временный пароль, который он ещё не сменил. */
export async function mustChangePassword(email: string) {
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return false;
  const row = await runtime.DB.prepare("SELECT must_change_password AS mustChange FROM app_users WHERE email = ?")
    .bind(email)
    .first<{ mustChange: number }>();
  return Boolean(row?.mustChange);
}

/** Служебный «пользователь» фоновой задачи: у него нет сессии и нет пароля. */
export const SYNC_TASK_ACTOR = "планировщик";

/**
 * Проверка служебного токена фоновой задачи.
 *
 * Нужна, потому что синхронизацию по расписанию запускает не человек, а таймер
 * на сервере — сессии у него быть не может. Токен лежит в .env, сравнивается с
 * постоянным временем и работает только через заголовок Authorization.
 */
async function isSyncTaskRequest() {
  const expected = getRuntimeEnv().SYNC_TASK_TOKEN;
  if (!expected) return false;
  const provided = (await headers()).get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function authorizeApi(adminOnly = false): Promise<{ user: AppUser } | { response: Response }> {
  if (await isSyncTaskRequest()) {
    return {
      user: {
        email: SYNC_TASK_ACTOR,
        fullName: "Фоновая синхронизация",
        role: "admin",
        status: "active",
        createdAt: new Date().toISOString(),
      },
    };
  }

  const user = await getAppUser();
  if (!user) return { response: Response.json({ error: "Требуется вход." }, { status: 401 }) };
  if (user.status !== "active") return { response: Response.json({ error: "Доступ ещё не одобрен." }, { status: 403 }) };
  if (adminOnly && !hasAdminAccess(user)) return { response: Response.json({ error: "Требуются права администратора." }, { status: 403 }) };
  return { user };
}

/** Путь на страницу входа с безопасным возвратом обратно. */
export function loginPath(returnTo = "/") {
  const safe = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
  return `/login?next=${encodeURIComponent(safe)}`;
}
