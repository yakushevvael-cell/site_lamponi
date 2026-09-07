import { authorizeApi } from "@/lib/app-auth";
import { generateTemporaryPassword, hashPassword } from "@/lib/password.mjs";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { destroyAllSessions } from "@/lib/session";

export async function GET() {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const rows = await runtime.DB.prepare(
    `SELECT email, full_name AS fullName, role, status,
            created_at AS createdAt, approved_at AS approvedAt,
            last_seen_at AS lastSeenAt,
            CASE WHEN password_hash IS NULL THEN 0 ELSE 1 END AS hasPassword,
            must_change_password AS mustChangePassword,
            locked_until AS lockedUntil
     FROM app_users
     ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, created_at DESC`,
  ).all();
  return Response.json({ users: rows.results });
}

export async function POST(request: Request) {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const body = await request.json().catch(() => null) as { email?: unknown; action?: unknown; accessLevel?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const action = body?.action;
  const accessLevel = body?.accessLevel;
  if (!email || !["approve", "block", "set_role", "reset_password"].includes(String(action))) return Response.json({ error: "Некорректное действие." }, { status: 400 });
  if (action === "set_role" && accessLevel !== "simple" && accessLevel !== "full") return Response.json({ error: "Выберите уровень доступа." }, { status: 400 });
  if (email === auth.user.email && (action === "block" || action === "set_role")) return Response.json({ error: "Нельзя изменить права или заблокировать собственный аккаунт." }, { status: 400 });

  const target = await runtime.DB.prepare("SELECT role, status FROM app_users WHERE email = ?").bind(email).first<{ role: string; status: string }>();
  if (!target) return Response.json({ error: "Пользователь не найден." }, { status: 404 });
  // Сброс пароля разрешён и для владельца: иначе забытый пароль админа
  // означал бы потерю доступа ко всей системе.
  if (target.role === "admin" && action !== "reset_password") {
    return Response.json({ error: "Права владельца изменить нельзя." }, { status: 403 });
  }

  if (action === "reset_password") {
    // Временный пароль показывается администратору один раз и нигде не хранится
    // в открытом виде: в базу идёт только его хеш.
    const temporaryPassword = generateTemporaryPassword();
    await runtime.DB.prepare(
      `UPDATE app_users
       SET password_hash = ?, password_updated_at = CURRENT_TIMESTAMP,
           must_change_password = 1, failed_login_count = 0, locked_until = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE email = ?`,
    ).bind(await hashPassword(temporaryPassword), email).run();
    // Все прежние сессии этого пользователя завершаются.
    await destroyAllSessions(email);
    return Response.json({
      ok: true,
      email,
      temporaryPassword,
      note: "Передайте пароль сотруднику лично. При первом входе система попросит его сменить.",
    });
  }

  let result;
  if (action === "approve") {
    const role = accessLevel === "full" ? "manager" : accessLevel === "simple" ? "user" : target.role;
    result = await runtime.DB.prepare(
      "UPDATE app_users SET status = 'active', role = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE email = ?",
    ).bind(role, auth.user.email, email).run();
  } else if (action === "set_role") {
    const role = accessLevel === "full" ? "manager" : "user";
    result = await runtime.DB.prepare("UPDATE app_users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?").bind(role, email).run();
  } else {
    result = await runtime.DB.prepare("UPDATE app_users SET status = 'blocked', updated_at = CURRENT_TIMESTAMP WHERE email = ? AND role <> 'admin'").bind(email).run();
  }
  if (!result.meta.changes) return Response.json({ error: "Пользователь не найден или действие запрещено." }, { status: 404 });
  const updated = await runtime.DB.prepare("SELECT role, status FROM app_users WHERE email = ?").bind(email).first<{ role: string; status: string }>();
  return Response.json({ ok: true, email, role: updated?.role, status: updated?.status });
}
