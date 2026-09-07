import { getAppUser } from "@/lib/app-auth";
import { hashPassword, validatePassword, verifyPassword } from "@/lib/password.mjs";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { createSession, destroyAllSessions } from "@/lib/session";

/** Смена собственного пароля. */
export async function POST(request: Request) {
  const user = await getAppUser();
  if (!user) return Response.json({ error: "Требуется вход." }, { status: 401 });
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const body = await request.json().catch(() => null) as { currentPassword?: unknown; newPassword?: unknown } | null;
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";

  const problem = validatePassword(newPassword);
  if (problem) return Response.json({ error: problem }, { status: 400 });

  const row = await runtime.DB.prepare("SELECT password_hash AS passwordHash FROM app_users WHERE email = ?")
    .bind(user.email)
    .first<{ passwordHash: string | null }>();
  if (!row?.passwordHash || !(await verifyPassword(currentPassword, row.passwordHash))) {
    return Response.json({ error: "Текущий пароль указан неверно." }, { status: 403 });
  }
  if (await verifyPassword(newPassword, row.passwordHash)) {
    return Response.json({ error: "Новый пароль совпадает со старым." }, { status: 400 });
  }

  await runtime.DB.prepare(
    `UPDATE app_users
     SET password_hash = ?, password_updated_at = CURRENT_TIMESTAMP,
         must_change_password = 0, failed_login_count = 0, locked_until = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE email = ?`,
  ).bind(await hashPassword(newPassword), user.email).run();

  // Смена пароля завершает все сессии, включая чужие, и выдаёт новую текущую.
  await destroyAllSessions(user.email);
  await createSession(user.email);
  return Response.json({ ok: true });
}
