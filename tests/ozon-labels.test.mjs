import test from "node:test";
import assert from "node:assert/strict";
import { collectOzonLabelPdfs } from "../lib/ozon-labels.mjs";

function fixture(overrides = {}) {
  const tasks = new Map();
  const calls = [];
  let status = "processing";
  let id = 10;
  const deps = {
    scope: Math.random().toString(),
    readTask: async p => tasks.get(p),
    saveTask: async (p, task) => { tasks.set(p, task); },
    deleteTask: async p => { tasks.delete(p); },
    request: async (path, body) => {
      calls.push({ path, body });
      if (path.endsWith("/create")) {
        assert.deepEqual(Object.keys(body), ["posting_numbers"]);
        return { tasks: [{ task_id: ++id, task_type: "small_label" }] };
      }
      assert.deepEqual(Object.keys(body), ["task_id"]);
      return {
        status: { code: status, postings_count: 1, printed_postings_count: status === "completed" ? 1 : 0, unprinted_postings: [] },
        file_url: status === "completed" ? `https://cdn.ozon.ru/${body.task_id}.pdf` : "",
        error: { code: "", message: "" },
      };
    },
    fetchFile: async url => new Response(`%PDF-${url}`),
    ...overrides,
  };
  return { deps, calls, tasks, complete: () => { status = "completed"; } };
}

test("create → pending → completed keeps the task across independent calls", async () => {
  const f = fixture();
  assert.equal((await collectOzonLabelPdfs(["a"], f.deps)).ok, false);
  assert.equal(f.tasks.get("a").id, 11);
  f.complete();
  const result = await collectOzonLabelPdfs(["a"], { ...f.deps });
  assert.equal(result.ok, true);
  assert.equal(f.calls.filter(c => c.path.endsWith("/create")).length, 1);
  assert.equal(f.calls[2].body.task_id, 11);
  assert.match(new TextDecoder().decode(result.pdfs[0]), /^%PDF-/);
});

test("concurrent requests share the same task creation", async () => {
  const f = fixture();
  await Promise.all([collectOzonLabelPdfs(["a"], f.deps), collectOzonLabelPdfs(["a"], f.deps)]);
  assert.equal(f.calls.filter(c => c.path.endsWith("/create")).length, 1);
});

test("split postings retain requested page order and are not duplicated", async () => {
  const f = fixture(); f.complete();
  const result = await collectOzonLabelPdfs(["b", "a", "b"], f.deps);
  assert.equal(result.pdfs.length, 2);
  assert.deepEqual(f.calls.filter(c => c.path.endsWith("/create")).map(c => c.body.posting_numbers), [["b"], ["a"]]);
  assert.match(new TextDecoder().decode(result.pdfs[0]), /11.pdf/);
  assert.match(new TextDecoder().decode(result.pdfs[1]), /12.pdf/);
});

for (const status of [400, 401, 403, 404, 429, 500]) {
  test(`HTTP ${status} is an error, not perpetual preparation`, async () => {
    const f = fixture({ request: async () => { throw new Error(`HTTP ${status}`); } });
    await assert.rejects(collectOzonLabelPdfs(["a"], f.deps), new RegExp(`HTTP ${status}`));
  });
}

test("failed job reports Ozon error and can be recreated on manual retry", async () => {
  const f = fixture(); await collectOzonLabelPdfs(["a"], f.deps);
  await assert.rejects(collectOzonLabelPdfs(["a"], { ...f.deps, request: async () => ({ result: { status: "error", error: "INVALID_POSTING_STATE" } }) }), /INVALID_POSTING_STATE/);
  assert.equal(f.tasks.size, 0);
});

test("processing has a bounded lifetime", async () => {
  const f = fixture({ now: () => 1000 });
  await collectOzonLabelPdfs(["a"], f.deps);
  await assert.rejects(collectOzonLabelPdfs(["a"], { ...f.deps, now: () => 901000 }), /15 минут/);
});

test("download failure retains task for retry without re-creating it", async () => {
  const f = fixture(); f.complete();
  await assert.rejects(collectOzonLabelPdfs(["a"], { ...f.deps, fetchFile: async () => new Response("bad", { status: 503 }) }), /503/);
  assert.equal((await collectOzonLabelPdfs(["a"], f.deps)).ok, true);
  assert.equal(f.calls.filter(c => c.path.endsWith("/create")).length, 1);
});

test("HTML/JSON instead of PDF is rejected", async () => {
  const f = fixture({ fetchFile: async () => new Response('{"error":"bad"}') }); f.complete();
  await assert.rejects(collectOzonLabelPdfs(["a"], f.deps), /не является PDF/);
});

test("unknown status or completed without a URL is not treated as pending", async () => {
  for (const response of [{ status: "completed" }, { status: "unexpected" }]) {
    const f = fixture(); await collectOzonLabelPdfs(["a"], f.deps);
    await assert.rejects(collectOzonLabelPdfs(["a"], { ...f.deps, request: async () => response }), /Некорректный ответ/);
  }
});

test("malformed create response fails explicitly", async () => {
  for (const response of [{}, { tasks: [] }, { tasks: [{ task_id: 0 }] }, { tasks: [{ task_id: 1 }, { task_id: 2 }] }]) {
    const f = fixture({ request: async () => response });
    await assert.rejects(collectOzonLabelPdfs(["a"], f.deps), /некорректное задание/);
  }
});

test("PDF download receives no Seller API credentials", async () => {
  const f = fixture({ fetchFile: async (...args) => {
    assert.equal(args.length, 1);
    assert.match(args[0], /^https:\/\/cdn.ozon.ru\//);
    return new Response("%PDF-1.7");
  } }); f.complete();
  assert.equal((await collectOzonLabelPdfs(["a"], f.deps)).ok, true);
});

// Regression: the production v2 response contains an object, not a string status.
for (const code of ["pending", "in_progress"]) {
  test(`v2 object status ${code} waits without file_url or losing task`, async () => {
    const f = fixture();
    f.tasks.set("a", { id: 42, createdAt: Date.now() });
    const result = await collectOzonLabelPdfs(["a"], {
      ...f.deps,
      request: async (path, body) => {
        assert.equal(path, "/v2/posting/fbs/package-label/get");
        assert.deepEqual(body, { task_id: 42 });
        return { status: { code, postings_count: 1, printed_postings_count: 0 }, error: { code: "", message: "" } };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(f.tasks.get("a").id, 42);
  });
}

test("v2 completed recovers an existing task after the previous parser failed", async () => {
  const f = fixture(); f.complete();
  // An old task must still be downloaded when complete, even after the waiting deadline.
  f.tasks.set("a", { id: 42, createdAt: 1 });
  assert.equal((await collectOzonLabelPdfs(["a"], f.deps)).ok, true);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, { task_id: 42 });
});

test("v2 error object surfaces the actual Ozon reason", async () => {
  const f = fixture(); f.tasks.set("a", { id: 42, createdAt: Date.now() });
  await assert.rejects(collectOzonLabelPdfs(["a"], { ...f.deps, request: async () => ({
    status: { code: "error" }, error: { code: "LABEL_ERROR", message: "Отправление недоступно" },
  }) }), /Отправление недоступно/);
});

test("completed with unprinted postings never prints an incomplete PDF", async () => {
  for (const extra of [
    { unprinted_postings: [{ posting_number: "a", message: "Отменено" }] },
    { postings_count: 1, printed_postings_count: 0 },
  ]) {
    const f = fixture(); f.tasks.set("a", { id: 42, createdAt: Date.now() });
    await assert.rejects(collectOzonLabelPdfs(["a"], { ...f.deps,
      request: async () => ({ status: { code: "completed", ...extra }, file_url: "https://cdn.ozon.ru/a.pdf" }),
      fetchFile: async () => { assert.fail("must not download incomplete labels"); },
    }), /не сформировал все этикетки/);
  }
});

function afterShipFixture(state = { status: "awaiting_deliver" }) {
  let time = 1000;
  let ready = false;
  const calls = [];
  const f = fixture({ now: () => time, request: async (path, body) => {
    calls.push({ path, body });
    if (path.endsWith("/create")) {
      if (!ready) throw new Error("Ozon: NO_POSTINGS_FOR_BATCH_DOWNLOAD");
      return { tasks: [{ task_id: 42, task_type: "small_label" }] };
    }
    if (path === "/v3/posting/fbs/get") return { result: state };
    assert.equal(body.task_id, 42, "local waiting marker must never be sent to Ozon");
    return { status: { code: "completed" }, file_url: "https://cdn.ozon.ru/a.pdf" };
  } });
  return { ...f, calls, advance: ms => { time += ms; }, ready: () => { ready = true; } };
}

test("immediate label refusal after ship waits durably, then downloads without another ship", async () => {
  const f = afterShipFixture();
  assert.equal((await collectOzonLabelPdfs(["a"], f.deps)).ok, false);
  assert.deepEqual(f.tasks.get("a"), { id: 0, createdAt: 1000 });
  f.advance(30_000);
  assert.equal((await collectOzonLabelPdfs(["a"], { ...f.deps })).ok, false);
  assert.equal(f.calls.length, 2, "no API calls during the first minute");
  f.advance(30_000); f.ready();
  assert.equal((await collectOzonLabelPdfs(["a"], f.deps)).ok, true);
  assert.deepEqual(f.tasks.get("a").id, 42);
  assert.equal(f.calls.some(c => c.path.endsWith("/ship")), false);
});

test("repeated NO_POSTINGS does not reset the waiting deadline", async () => {
  const f = afterShipFixture();
  await collectOzonLabelPdfs(["a"], f.deps);
  f.advance(60_000);
  await collectOzonLabelPdfs(["a"], f.deps);
  assert.equal(f.tasks.get("a").createdAt, 1000);
  f.advance(840_000);
  await assert.rejects(collectOzonLabelPdfs(["a"], f.deps), /15 минут/);
});

for (const state of [
  { status: "awaiting_verification", substatus: "posting_split_pending" },
  { status: "awaiting_packaging", substatus: "posting_split_pending" },
]) {
  test(`split transition ${state.status} waits`, async () => {
    const f = afterShipFixture(state);
    assert.equal((await collectOzonLabelPdfs(["a"], f.deps)).ok, false);
  });
}

for (const state of [
  { status: "cancelled" },
  { status: "cancelled_from_split_pending" },
  { status: "awaiting_packaging", substatus: "ship_failed" },
  { status: "delivered" },
]) {
  test(`NO_POSTINGS with ${state.substatus ?? state.status} remains an explicit error`, async () => {
    const f = afterShipFixture(state);
    await assert.rejects(collectOzonLabelPdfs(["a"], f.deps), new RegExp(state.substatus ?? state.status));
    assert.equal(f.tasks.size, 0);
  });
}
