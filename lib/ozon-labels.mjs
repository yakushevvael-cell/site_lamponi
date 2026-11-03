/** Ozon scanit: durable create → poll → download, without sleeping in an HTTP request. */
const inFlight = new Map();
const MAX_WAIT_MS = 15 * 60 * 1000;
const AFTER_SHIP_WAIT_MS = 60_000;

/**
 * One task per posting preserves page order even when Ozon groups labels by format.
 * Dependencies are injected so the complete asynchronous protocol can be tested offline.
 * @param {string[]} postings
 * @param {{ request: Function, readTask: Function, saveTask: Function, deleteTask: Function,
 * fetchFile: Function, scope: string, now?: Function }} deps
 */
export async function collectOzonLabelPdfs(postings, deps) {
  const pdfs = [];
  for (const posting of [...new Set(postings)]) {
    const key = `${deps.scope}:${posting}`;
    let work = inFlight.get(key);
    if (!work) {
      work = readPostingLabel(posting, deps);
      inFlight.set(key, work);
    }
    let result;
    try { result = await work; }
    finally { if (inFlight.get(key) === work) inFlight.delete(key); }
    if (!result.ok) return result;
    pdfs.push(result.pdf);
  }
  if (!pdfs.length) throw new Error("Не указаны отправления для этикетки Ozon.");
  return { ok: true, pdfs };
}

async function readPostingLabel(posting, deps) {
  const now = deps.now ?? Date.now;
  let task = await deps.readTask(posting);
  // task_id=0 is a local marker: Ozon has not accepted a label job yet.
  // Persisting it prevents reloads/restarts from resetting the bounded waiting period.
  if (task?.id === 0 && now() - task.createdAt < AFTER_SHIP_WAIT_MS) {
    return waitingForPosting(posting);
  }
  if (task?.id === 0 && now() - task.createdAt >= MAX_WAIT_MS) {
    await deps.deleteTask(posting);
    throw new Error(`Ozon не разрешил создание этикетки ${posting} за 15 минут после сборки. Проверьте статус отправления в Ozon.`);
  }
  if (!task || task.id === 0) {
    let created;
    try {
      created = await deps.request("/v3/posting/fbs/package-label/create", { posting_numbers: [posting] });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("NO_POSTINGS_FOR_BATCH_DOWNLOAD")) throw error;
      // A successful ship is asynchronous. Only confirmed transitional states may wait.
      const details = await deps.request("/v3/posting/fbs/get", { posting_number: posting });
      const state = details?.result ?? details;
      if (state?.substatus === "ship_failed") {
        throw new Error(`Ozon: сборка отправления ${posting} не удалась (ship_failed). Проверьте отправление в кабинете Ozon.`);
      }
      const transitioning = ["awaiting_deliver", "awaiting_verification"].includes(state?.status)
        || (state?.status === "awaiting_packaging" && state?.substatus === "posting_split_pending");
      if (!transitioning) {
        throw new Error(`Ozon не разрешил этикетку ${posting}: NO_POSTINGS_FOR_BATCH_DOWNLOAD, статус ${state?.status ?? "неизвестен"}, подстатус ${state?.substatus ?? "не указан"}.`);
      }
      if (!task) await deps.saveTask(posting, { id: 0, createdAt: now() });
      return waitingForPosting(posting);
    }
    const tasks = created?.tasks;
    // A single posting has one label format. Never silently discard extra tasks.
    if (!Array.isArray(tasks) || tasks.length !== 1 || !Number.isSafeInteger(tasks[0]?.task_id) || tasks[0].task_id <= 0) {
      throw new Error(`Ozon вернул некорректное задание этикетки для ${posting}.`);
    }
    task = { id: tasks[0].task_id, createdAt: now() };
    await deps.saveTask(posting, task);
  }
  const response = await deps.request("/v2/posting/fbs/package-label/get", { task_id: task.id });
  const result = response?.result ?? response;
  // /v2 returns status as { code, postings_count, printed_postings_count, unprinted_postings }.
  const statusInfo = result?.status;
  const status = String(typeof statusInfo === "object" && statusInfo !== null
    ? statusInfo.code ?? "" : statusInfo ?? "").toLowerCase();
  const error = result?.error;
  if (status === "failed" || status === "error" || (error && (typeof error === "string" || error.code || error.message))) {
    await deps.deleteTask(posting);
    const detail = typeof error === "string" ? error : error?.message || error?.code || status;
    throw new Error(`Ozon не сформировал этикетку ${posting}: ${String(detail).slice(0, 200)}`);
  }
  if (["pending", "processing", "in_progress"].includes(status)) {
    if (now() - task.createdAt >= MAX_WAIT_MS) {
      await deps.deleteTask(posting);
      throw new Error(`Ozon не сформировал этикетку ${posting} за 15 минут. Повторите подготовку вручную.`);
    }
    return { ok: false, notReady: true, message: `Ozon готовит этикетку ${posting} (задание ${task.id}).` };
  }
  // completed only means the job ended: Ozon may have skipped the requested posting.
  const unprinted = Array.isArray(statusInfo?.unprinted_postings) ? statusInfo.unprinted_postings : [];
  const requested = statusInfo?.postings_count;
  const printed = statusInfo?.printed_postings_count;
  if (status === "completed" && (unprinted.length > 0 || (typeof requested === "number" && typeof printed === "number" && printed < requested))) {
    await deps.deleteTask(posting);
    const detail = unprinted.map((entry) => `${entry.posting_number ?? posting}: ${entry.message ?? "этикетка не сформирована"}`).join("; ");
    throw new Error(`Ozon не сформировал все этикетки: ${detail || `готово ${printed} из ${requested}`}`);
  }
  if (status !== "completed" || typeof result?.file_url !== "string" || !result.file_url) {
    throw new Error(`Некорректный ответ Ozon для этикетки ${posting}: статус «${status}», ссылка на PDF ${result?.file_url ? "есть" : "отсутствует"}.`);
  }
  // file_url is a signed download URL. Never send Seller API credentials to it.
  const url = new URL(result.file_url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Ozon вернул некорректную ссылку на PDF.");
  const file = await deps.fetchFile(url.href);
  if (!file.ok) throw new Error(`Не удалось скачать этикетку Ozon: HTTP ${file.status}.`);
  const pdf = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(pdf.subarray(0, 5)) !== "%PDF-") throw new Error("Ozon вернул файл, который не является PDF.");
  return { ok: true, pdf };
}

function waitingForPosting(posting) {
  return { ok: false, notReady: true, message: `Ozon завершает сборку отправления ${posting}. Этикетка будет запрошена повторно автоматически.` };
}
