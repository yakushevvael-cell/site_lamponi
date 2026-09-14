/** Кого можно поставить на сборку: сотрудники с правом «Сборка по заданиям». */
import { authorizePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";

export async function GET() {
  const auth = await authorizePermission("warehouse.tasks");
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const rows = await runtime.DB.prepare(
    `SELECT u.email, u.full_name AS fullName, u.role, u.last_seen_at AS lastSeenAt
     FROM app_users u
     WHERE u.status = 'active'
       AND (u.role IN ('admin', 'manager')
            OR EXISTS (SELECT 1 FROM user_permissions p WHERE p.email = u.email AND p.code = 'warehouse.pick'))
     ORDER BY u.full_name, u.email`,
  ).all<{ email: string; fullName: string | null; role: string; lastSeenAt: string | null }>();

  return Response.json({ pickers: rows.results });
}
