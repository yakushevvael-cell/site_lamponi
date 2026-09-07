import { getAppUser } from "@/lib/app-auth";

export async function GET() {
  const user = await getAppUser();
  if (!user) return Response.json({ authenticated: false }, { status: 401 });
  return Response.json({ authenticated: true, ...user });
}
