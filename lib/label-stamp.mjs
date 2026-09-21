/**
 * Впечатывание артикула и размера на этикетку Ozon (ТЗ, п. 5, доработка).
 *
 * Этикетка Ozon приходит готовым PDF со штрихкодом (Data Matrix) в верхней
 * половине. Трогать его нельзя: перекрытая подложка = несканируемая этикетка на
 * сдаче. Поэтому текст ставится в НИЖНЮЮ белую полосу под номером отправления —
 * это заведомо пустая зона, далеко от кода. Одна строка на страницу: после
 * разъединения многотоварного отправления каждая страница — отдельное изделие.
 *
 * Модуль намеренно «отказобезопасный»: любую ошибку пробрасывает, а вызывающий
 * код (lib/labels.ts) в этом случае сохраняет исходный PDF без изменений — как
 * работало раньше. Впечатывание не может сломать печать или отгрузку.
 */
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

import { LABEL_FONT_BASE64 } from "./label-font.mjs";

let fontBytesCache = null;
function fontBytes() {
  if (!fontBytesCache) fontBytesCache = Uint8Array.from(Buffer.from(LABEL_FONT_BASE64, "base64"));
  return fontBytesCache;
}

/**
 * Настройки размещения. Координаты в пунктах PDF (1 pt = 1/72"). Ноль по Y —
 * низ страницы. Если после теста на реальной этикетке текст встанет неудачно,
 * правится здесь одним местом.
 */
const STAMP = {
  bottomMarginPt: 8, // отступ подложки от нижнего края
  sideMarginPt: 6, // минимальный отступ текста от боковых краёв
  paddingPt: 3, // белое поле вокруг текста внутри подложки
  maxFontPt: 13,
  minFontPt: 7,
};

/** Строка под изделие: «артикул / размер» или просто «артикул». */
export function formatLabelLine(line) {
  const article = String(line?.article ?? "").trim();
  const size = String(line?.size ?? "").trim();
  if (!article && !size) return "";
  if (!size) return article;
  if (!article) return size;
  return `${article}  /  ${size}`;
}

/** Подбирает кегль так, чтобы строка влезла по ширине страницы. */
function fitFontSize(font, text, maxWidth) {
  let size = STAMP.maxFontPt;
  while (size > STAMP.minFontPt && font.widthOfTextAtSize(text, size) > maxWidth) {
    size -= 0.5;
  }
  return size;
}

/**
 * Впечатывает строки на страницы PDF: lines[i] — на i-ю страницу. Если строк
 * меньше, чем страниц, лишние страницы остаются как есть; если строка пустая —
 * страница пропускается. Возвращает новый PDF (Uint8Array).
 */
export async function stampLabelLines(pdfBytes, lines) {
  if (!Array.isArray(lines) || lines.length === 0) return pdfBytes;

  const pdf = await PDFDocument.load(pdfBytes);
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes(), { subset: true });
  const pages = pdf.getPages();

  let drew = false;
  for (let index = 0; index < pages.length; index += 1) {
    const text = formatLabelLine(lines[index] ?? lines[0]);
    if (!text) continue;

    const page = pages[index];
    const { width } = page.getSize();
    const maxTextWidth = width - 2 * (STAMP.sideMarginPt + STAMP.paddingPt);
    const fontSize = fitFontSize(font, text, Math.max(20, maxTextWidth));

    const textWidth = font.widthOfTextAtSize(text, fontSize);
    const textHeight = font.heightAtSize(fontSize);
    const boxWidth = Math.min(width - 2 * STAMP.sideMarginPt, textWidth + 2 * STAMP.paddingPt);
    const boxHeight = textHeight + 2 * STAMP.paddingPt;
    const boxX = (width - boxWidth) / 2;
    const boxY = STAMP.bottomMarginPt;

    // Белая подложка — чтобы текст читался, даже если под ним есть светлая рамка.
    page.drawRectangle({
      x: boxX,
      y: boxY,
      width: boxWidth,
      height: boxHeight,
      color: rgb(1, 1, 1),
    });
    page.drawText(text, {
      x: boxX + (boxWidth - textWidth) / 2,
      y: boxY + STAMP.paddingPt,
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
    });
    drew = true;
  }

  if (!drew) return pdfBytes;
  return pdf.save();
}
