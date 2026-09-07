import { getRuntimeEnv } from "@/lib/runtime-env";
import { verifyPassword } from "@/lib/password.mjs";
import { createSession, destroyAllSessions } from "@/lib/session";

/** Блокировка после серии неудачных попыток — защита от подбора пароля. */
const MAX_FAILED_ATTEMPTS = 8;
const LOCK_MINUTES = 15;

type UserRow = {
  email: string;
  fullName: string | null;
  role: string;
  status: string;
  passwordHash: string | null;
  mustChangePassword: number;
  failedLoginCount: number;
  lockedUntil: string | null;
};

export async function POST(request: Request) {
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const db = runtime.DB;

  const body = await request.json().catch(() => null) as { email?: unknown; password?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password) return Response.json({ error: "Введите почту и пароль." }, { status: 400 });

  const user = await db.prepare(
    `SELECT email, full_name AS fullName, role, status,
            password_hash AS passwordHash, must_change_password AS mustChangePassword,
            failed_login_count AS failedLoginCount, locked_until AS lockedUntil
     FROM app_users WHERE email = ?`,
  ).bind(email).first<UserRow>();

  // Ответ одинаковый и для несуществующей почты, и для неверного пароля:
  // иначе форму входа можно использовать как справочник сотрудников.
  const invalid = () => Response.json({ error: "Неверная почта или пароль." }, { status: 401 });

  if (!user || !user.passwordHash) {
    // Пароль всё равно проверяем, чтобы время ответа не выдавало, есть ли такой пользователь.
    await verifyPassword(password, "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==");
    return invalid();
  }

  if (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) {
    const minutes = Math.ceil((Date.parse(user.lockedUntil) - Date.now()) / 60000);
    return Response.json({ error: `Слишком много неудачных попыток. Попробуйте через ${minutes} мин.` }, { status: 429 });
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    const failed = Number(user.failedLoginCount ?? 0) + 1;
    const lockedUntil = failed >= MAX_FAILED_ATTEMPTS
      ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString()
      : null;
    await db.prepare(
      "UPDATE app_users SET failed_login_count = ?, locked_until = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?",
    ).bind(failed >= MAX_FAILED_ATTEMPTS ? 0 : failed, lockedUntil, email).run();
    return invalid();
  }

  if (user.status === "blocked") {
    return Response.json({ error: "Доступ заблокирован администратором." }, { status: 403 });
  }

  await db.prepare(
    "UPDATE app_users SET failed_login_count = 0, locked_until = NULL, last_seen_at = CURRENT_TIMESTAMP WHERE email = ?",
  ).bind(email).run();

  // Вход завершает прежние сессии этого пользователя: так «выйти везде»
  // получается само собой, а украденная старая cookie перестаёт работать.
  await destroyAllSessions(email);
  await createSession(email);

  return Response.json({
    ok: true,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    status: user.status,
    mustChangePassword: Boolean(user.mustChangePassword),
    // Ждущего одобрения пускаем внутрь, но он увидит только страницу ожидания.
    pending: user.status !== "active",
  });
}
