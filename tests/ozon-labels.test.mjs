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
      return { result: { status, file_url: `https://cdn.ozon.ru/${body.task_id}.pdf` } };
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
