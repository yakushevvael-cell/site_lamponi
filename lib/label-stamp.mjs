/**
 * Впечатывание артикула и размера на этикетку Ozon (ТЗ, п. 5, доработка).
 *
 * Этикетка Ozon приходит готовым PDF с QR-кодом. Трогать его нельзя: перекрытый
 * код = несканируемая этикетка на сдаче. Поэтому текст ставится мелко в узкую
 * белую полосу у самого нижнего края страницы, ниже кода. Одна строка на
 * страницу: после
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
 * Настройки размещения. Размеры — доли высоты страницы: одна и та же раскладка
 * годится и для 58×40, и для 75×120. Ноль по Y — низ страницы. QR-код кончается
 * примерно в 17% высоты от низа, текст с подложкой держится в нижних ~11%.
 */
const STAMP = {
  bottomMargin: 0.015, // отступ подложки от нижнего края, доля высоты страницы
  band: 0.11, // полоса у нижнего края под текст, доля высоты страницы
  sideMarginPt: 6, // минимальный отступ от боковых краёв
  paddingPt: 1, // белое поле вокруг текста внутри подложки
  maxFontPt: 9,
  minFontPt: 5,
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

/** Подбирает кегль так, чтобы строка влезла по ширине и по высоте полосы. */
function fitFontSize(font, text, maxWidth, maxHeight) {
  const unitHeight = font.heightAtSize(1);
  let size = Math.min(STAMP.maxFontPt, Math.max(STAMP.minFontPt, maxHeight / unitHeight));
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
  // Без subset: у pdf-lib урезание шрифта теряет часть глифов — на этикетке
  // от «ЛМ-1200 / 17» оставалось «- 00».
  const font = await pdf.embedFont(fontBytes(), { subset: false });
  const pages = pdf.getPages();

  let drew = false;
  for (let index = 0; index < pages.length; index += 1) {
    const text = formatLabelLine(lines[index] ?? lines[0]);
    if (!text) continue;

    const page = pages[index];
    const { x, y, width, height } = page.getMediaBox();
    const bottom = STAMP.bottomMargin * height;
    const maxTextWidth = width - 2 * (STAMP.sideMarginPt + STAMP.paddingPt);
    const maxTextHeight = STAMP.band * height - bottom - 2 * STAMP.paddingPt;
    const fontSize = fitFontSize(font, text, Math.max(20, maxTextWidth), maxTextHeight);

    const textWidth = font.widthOfTextAtSize(text, fontSize);
    const textHeight = font.heightAtSize(fontSize);
    const descent = textHeight - font.heightAtSize(fontSize, { descender: false });
    const boxWidth = Math.min(width - 2 * STAMP.sideMarginPt, textWidth + 2 * STAMP.paddingPt);
    const boxHeight = textHeight + 2 * STAMP.paddingPt;
    const boxX = x + (width - boxWidth) / 2;
    const boxY = y + bottom;

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
      y: boxY + STAMP.paddingPt + descent,
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
    });
    drew = true;
  }

  if (!drew) return pdfBytes;
  return pdf.save();
}
