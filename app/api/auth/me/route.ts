import { getAppUser } from "@/lib/app-auth";
import { accessLevelOfRole } from "@/lib/permission-codes";
import { readEffectivePermissions } from "@/lib/permissions";

export async function GET() {
  const user = await getAppUser();
  if (!user) return Response.json({ authenticated: false }, { status: 401 });
  // Права нужны интерфейсу, чтобы не показывать пункты, которые сервер всё
  // равно не отдаст. Решение о доступе принимает сервер, это только подсказка.
  const permissions = await readEffectivePermissions(user);
  return Response.json({
    authenticated: true,
    ...user,
    accessLevel: accessLevelOfRole(user.role),
    permissions,
  });
}
