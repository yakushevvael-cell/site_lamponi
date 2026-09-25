import assert from "node:assert/strict";
import test from "node:test";

import { describeOzonPostingState } from "../lib/ozon-exemplars.mjs";

test("отменённое в Ozon отправление: собирать не нужно", () => {
  const state = describeOzonPostingState("cancelled");
  assert.equal(state.kind, "cancelled");
  assert.match(state.message, /отменено/);
});

test("уже собранное отправление: остаётся забрать этикетку", () => {
  assert.equal(describeOzonPostingState("awaiting_deliver").kind, "shipped");
  assert.match(describeOzonPostingState("awaiting_deliver").message, /ожидает отгрузки/);
});

test("прочие статусы называются по-русски, неизвестные — кодом", () => {
  assert.equal(describeOzonPostingState("arbitration").kind, "other");
  assert.match(describeOzonPostingState("arbitration").message, /арбитраж/);
  assert.match(describeOzonPostingState("something_new").message, /something_new/);
  assert.equal(describeOzonPostingState("").kind, "unknown");
});
