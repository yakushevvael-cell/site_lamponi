/** Ozon scanit: durable create → poll → download, without sleeping in an HTTP request. */
const inFlight = new Map();
const MAX_WAIT_MS = 15 * 60 * 1000;

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
  if (!task) {
    const created = await deps.request("/v3/posting/fbs/package-label/create", { posting_numbers: [posting] });
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
  const status = String(result?.status ?? "").toLowerCase();
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
