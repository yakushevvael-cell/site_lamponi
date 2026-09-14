/**
 * Проверка прав на сервере.
 *
 * ТЗ, п. 2: ограничения режутся на сервере, а не скрытием вкладок в
 * интерфейсе. Боковое меню прячет пункты только ради удобства — каждый
 * маршрут и каждая страница всё равно спрашивают право здесь.
 */
import { redirect } from "next/navigation";

import { authorizeApi, getAppUser, loginPath, mustChangePassword, type AppUser } from "@/lib/app-auth";
import {
  effectivePermissions,
  isPermissionCode,
  type PermissionCode,
} from "@/lib/permission-codes";
import { getRuntimeEnv } from "@/lib/runtime-env";

/** Галочки, выданные лично этому человеку. Без учёта уровня доступа. */
export async function readGrantedPermissions(email: string): Promise<PermissionCode[]> {
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return [];
  const rows = await runtime.DB.prepare("SELECT code FROM user_permissions WHERE email = ?")
    .bind(email.trim().toLowerCase())
    .all<{ code: string }>();
  return rows.results.map((row) => row.code).filter(isPermissionCode);
}

/** Права с учётом уровня доступа: полный доступ и владелец получают всё. */
export async function readEffectivePermissions(user: Pick<AppUser, "email" | "role">): Promise<PermissionCode[]> {
  if (user.role === "admin" || user.role === "manager") return effectivePermissions(user.role, []);
  return effectivePermissions(user.role, await readGrantedPermissions(user.email));
}

export type PermissionContext = { user: AppUser; permissions: PermissionCode[] };

/** Проверка для API-маршрута: либо контекст с правами, либо готовый ответ 401/403. */
export async function authorizePermission(
  code: PermissionCode | PermissionCode[],
): Promise<PermissionContext | { response: Response }> {
  const auth = await authorizeApi();
  if ("response" in auth) return { response: auth.response };
  const permissions = await readEffectivePermissions(auth.user);
  const needed = Array.isArray(code) ? code : [code];
  if (!needed.some((value) => permissions.includes(value))) {
    return { response: Response.json({ error: "Недостаточно прав для этого действия." }, { status: 403 }) };
  }
  return { user: auth.user, permissions };
}

/** То же для страницы: без права пользователя уводим на обзор. */
export async function requirePagePermission(
  returnTo: string,
  code: PermissionCode | PermissionCode[],
): Promise<PermissionContext> {
  const user = await getAppUser();
  if (!user) redirect(loginPath(returnTo));
  if (user.status !== "active") redirect("/access-pending");
  if (await mustChangePassword(user.email)) redirect("/password");
  const permissions = await readEffectivePermissions(user);
  const needed = Array.isArray(code) ? code : [code];
  if (!needed.some((value) => permissions.includes(value))) redirect("/");
  return { user, permissions };
}

/**
 * Переписывает набор галочек пользователя.
 * Права владельца и полного доступа галочками не описываются — им отказываем.
 */
export async function writeGrantedPermissions(
  db: D1Database,
  email: string,
  codes: PermissionCode[],
  actorEmail: string,
) {
  const target = email.trim().toLowerCase();
  const unique = [...new Set(codes.filter(isPermissionCode))];
  const statements = [db.prepare("DELETE FROM user_permissions WHERE email = ?").bind(target)];
  for (const code of unique) {
    statements.push(
      db.prepare(
        `INSERT INTO user_permissions (email, code, granted_by, granted_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(email, code) DO UPDATE SET granted_by = excluded.granted_by, granted_at = excluded.granted_at`,
      ).bind(target, code, actorEmail),
    );
  }
  await db.batch(statements);
  return unique;
}
