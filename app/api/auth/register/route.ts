import { hasAnyUser } from "@/lib/app-auth";
import { hashPassword, validatePassword } from "@/lib/password.mjs";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { createSession } from "@/lib/session";

/**
 * Регистрация нового сотрудника.
 *
 * Логика допуска сохранена с прежней версии: первый зарегистрировавшийся
 * становится администратором с активным доступом, остальные ждут одобрения
 * на вкладке «Пользователи». Изменилось одно — пароль теперь задаёт человек,
 * а не подтверждает внешняя платформа.
 */
export async function POST(request: Request) {
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  const body = await request.json().catch(() => null) as {
    email?: unknown;
    password?: unknown;
    fullName?: unknown;
    phone?: unknown;
  } | null;

  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const fullName = typeof body?.fullName === "string" ? body.fullName.trim().slice(0, 200) : "";
  const phone = typeof body?.phone === "string" ? body.phone.trim().slice(0, 32) : "";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "Введите корректный адрес почты." }, { status: 400 });
  }
  if (!fullName) return Response.json({ error: "Укажите имя и фамилию." }, { status: 400 });
  const passwordProblem = validatePassword(password);
  if (passwordProblem) return Response.json({ error: passwordProblem }, { status: 400 });

  const existing = await db.prepare("SELECT email FROM app_users WHERE email = ?").bind(email).first<{ email: string }>();
  if (existing) {
    return Response.json({ error: "Такая почта уже зарегистрирована. Войдите или попросите администратора сбросить пароль." }, { status: 409 });
  }

  const firstUser = !(await hasAnyUser());
  const role = firstUser ? "admin" : "user";
  const status = firstUser ? "active" : "pending";
  const passwordHash = await hashPassword(password);

  await db.prepare(
    `INSERT INTO app_users
       (email, phone, full_name, role, status, password_hash, password_updated_at,
        approved_by, approved_at, last_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, CASE WHEN ? = 'active' THEN CURRENT_TIMESTAMP ELSE NULL END,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(email, phone || null, fullName, role, status, passwordHash, firstUser ? email : null, status).run();

  await createSession(email);
  return Response.json({ ok: true, role, status, firstUser }, { status: 201 });
}
