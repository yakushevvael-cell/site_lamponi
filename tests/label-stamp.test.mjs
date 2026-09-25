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

for (const [width, height] of [[164, 113], [340, 212], [212, 340]]) {
  test(`страница ${width}×${height}: мелкая строка у нижнего края, ниже QR-кода`, async () => {
    const pdf = await stamp(width, height);
    const match = pdf.match(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/);
    assert.ok(match, "текст без поворота");
    const size = Number(pdf.match(/([\d.]+) Tf/)[1]);
    assert.ok(size <= 9, `кегль ${size} должен быть мелким`);
    // Верх строки не выше нижних 11% страницы — там QR-кода нет.
    assert.ok(Number(match[2]) + size <= height * 0.11 + 0.01, `y=${match[2]} должен быть внизу`);
  });
}
