import { getMarketplaceCredentials } from "@/lib/credentials";
import { authorizeApi } from "@/lib/app-auth";
import { getOzonRoles, OzonApiError } from "@/lib/ozon";
import { getRuntimeEnv } from "@/lib/runtime-env";

export async function GET() {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });
  const credentials = await getMarketplaceCredentials(runtime.DB, runtime, "ozon");
  if (!credentials.OZON_CLIENT_ID || !credentials.OZON_API_KEY) {
    return Response.json({ error: "Client-Id или API-ключ Ozon не добавлен." }, { status: 400 });
  }
  try {
    return Response.json(await getOzonRoles(credentials.OZON_CLIENT_ID, credentials.OZON_API_KEY));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось прочитать права API-ключа Ozon.";
    const status = error instanceof OzonApiError && error.status < 500 ? error.status : 502;
    return Response.json({ error: message }, { status });
  }
}
