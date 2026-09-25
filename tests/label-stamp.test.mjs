import assert from "node:assert/strict";
import test from "node:test";

import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";

import { stampLabelLines } from "../lib/label-stamp.mjs";

async function stamp(width, height) {
  const doc = await PDFDocument.create();
  doc.addPage([width, height]);
  const bytes = await stampLabelLines(await doc.save(), [{ article: "ЛМ-1200-45", size: "17,5" }]);
  // Потоки PDF сжаты — раскрываем все, чтобы проверять операторы и шрифт.
  const loaded = await PDFDocument.load(bytes);
  let text = "";
  for (const [, object] of loaded.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) {
      text += `${object.dict.toString()}\n${Buffer.from(decodePDFRawStream(object).decode()).toString("latin1")}\n`;
    } else {
      text += `${object.toString()}\n`;
    }
  }
  return text;
}

test("шрифт встраивается целиком: без subset глифы не теряются", async () => {
  const pdf = await stamp(340, 212);
  assert.ok(pdf.includes("/FontFile2"));
  assert.ok(!/\/BaseFont\s*\/[A-Z]{6}\+/.test(pdf), "урезанный шрифт теряет символы артикула");
});

test("альбомная страница: строка повёрнута вдоль правого края, над OZON", async () => {
  const pdf = await stamp(340, 212);
  // drawText с поворотом −90° пишет матрицу «~0 −1 1 ~0 x y Tm», x — у правого края.
  const match = pdf.match(/(\S+) -1 1 \S+ ([\d.]+) ([\d.]+) Tm/);
  assert.ok(match && Math.abs(Number(match[1])) < 1e-9, "текст должен быть повёрнут на −90°");
  assert.ok(Number(match[2]) > 340 * 0.93, `x=${match[2]} должен быть у правого края`);
});

test("книжная страница: строка горизонтально у верхнего края", async () => {
  const pdf = await stamp(212, 340);
  const match = pdf.match(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/);
  assert.ok(match, "текст без поворота");
  assert.ok(Number(match[2]) > 340 * 0.93, `y=${match[2]} должен быть у верхнего края`);
});
