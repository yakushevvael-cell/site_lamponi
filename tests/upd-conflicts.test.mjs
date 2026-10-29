import assert from "node:assert/strict";
import { test } from "node:test";

import {
  foreignUinProblem,
  parseUpdUploadDetails,
  removeUpdConflict,
  serializeUpdUploadDetails,
} from "../lib/upd-conflicts.mjs";

test("старый массив ошибок УПД читается без конфликтов", () => {
  assert.deepEqual(parseUpdUploadDetails(JSON.stringify(["Ошибка 1", "Ошибка 2"])), {
    problems: ["Ошибка 1", "Ошибка 2"],
    conflicts: [],
  });
});

test("конфликт УИН сохраняется структурированно", () => {
  const conflict = { uin: "6432600995897952", taskId: 28, taskNumber: "2026-10-28-WB-РОСТОВ-НА-ДОНУ" };
  const problem = foreignUinProblem(conflict);
  const parsed = parseUpdUploadDetails(serializeUpdUploadDetails([problem], [conflict]));
  assert.deepEqual(parsed, { problems: [problem], conflicts: [conflict] });
});

test("после открепления исчезает только выбранный конфликт", () => {
  const first = { uin: "U1", taskId: 1, taskNumber: "TASK-1" };
  const second = { uin: "U2", taskId: 2, taskNumber: "TASK-2" };
  const details = {
    problems: [foreignUinProblem(first), "Размер не совпал.", foreignUinProblem(second)],
    conflicts: [first, second],
  };
  assert.deepEqual(removeUpdConflict(details, "U1"), {
    problems: ["Размер не совпал.", foreignUinProblem(second)],
    conflicts: [second],
  });
});
