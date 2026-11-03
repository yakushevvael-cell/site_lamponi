import { authorizeApi } from "@/lib/app-auth";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { runMissingCancellationJobs } from "@/lib/missing-cancellations";

export async function POST() {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({error:"База данных недоступна."},{status:500});
  return Response.json(await runMissingCancellationJobs(runtime.DB, runtime));
}
