/**
 * Впечатывание артикула и размера на этикетку Ozon (ТЗ, п. 5, доработка).
 *
 * Этикетка Ozon приходит готовым PDF с QR-кодом посередине. Трогать его нельзя:
 * перекрытый код = несканируемая этикетка на сдаче. Поэтому текст ставится в
 * узкую белую полосу у верхнего края, над логотипом OZON, — там пусто и далеко
 * от кода. Одна строка на страницу: после
 * разъединения многотоварного отправления каждая страница — отдельное изделие.
 *
 * Модуль намеренно «отказобезопасный»: любую ошибку пробрасывает, а вызывающий
 * код (lib/labels.ts) в этом случае сохраняет исходный PDF без изменений — как
 * работало раньше. Впечатывание не может сломать печать или отгрузку.
 */
import { PDFDocument, degrees, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

import { LABEL_FONT_BASE64 } from "./label-font.mjs";

let fontBytesCache = null;
function fontBytes() {
  if (!fontBytesCache) fontBytesCache = Uint8Array.from(Buffer.from(LABEL_FONT_BASE64, "base64"));
  return fontBytesCache;
}

/**
 * Настройки размещения. Размеры — доли сторон этикетки: одна и та же раскладка
 * годится и для 58×40, и для 75×120. Над логотипом OZON свободно ~8% высоты. Ноль координат PDF — левый
 * нижний угол страницы.
 */
const STAMP = {
  edgeMargin: 0.012, // отступ подложки от верхнего края, доля высоты этикетки
  band: 0.07, // полоса над логотипом OZON под текст, доля высоты этикетки
  sideMargin: 0.04, // минимальный отступ от боковых краёв, доля ширины этикетки
  paddingPt: 1.5, // белое поле вокруг текста внутри подложки
  maxFontPt: 13,
  minFontPt: 6,
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
 * Где у этикетки верх. Ozon рисует этикетку книжной, но на альбомной странице
 * PDF содержимое повёрнуто: верх этикетки (логотип OZON) смотрит в правый край
 * страницы. На книжной странице верх — это верх.
 */
function labelFrame(page) {
  const { x, y, width, height } = page.getMediaBox();
  if (width > height) {
    // Строка идёт сверху вниз вдоль правого края, как надпись OZON.
    return { rotated: true, x, y, across: height, depth: width };
  }
  return { rotated: false, x, y, across: width, depth: height };
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
    const frame = labelFrame(page);
    const edge = STAMP.edgeMargin * frame.depth;
    const side = STAMP.sideMargin * frame.across;
    const maxTextWidth = frame.across - 2 * (side + STAMP.paddingPt);
    const maxTextHeight = STAMP.band * frame.depth - edge - 2 * STAMP.paddingPt;
    const fontSize = fitFontSize(font, text, Math.max(20, maxTextWidth), maxTextHeight);

    const textWidth = font.widthOfTextAtSize(text, fontSize);
    const textHeight = font.heightAtSize(fontSize);
    const descent = textHeight - font.heightAtSize(fontSize, { descender: false });
    const boxWidth = Math.min(frame.across - 2 * side, textWidth + 2 * STAMP.paddingPt);
    const boxHeight = textHeight + 2 * STAMP.paddingPt;
    // Координаты в системе этикетки: u — поперёк (слева направо при чтении),
    // v — от верхнего края вниз до нижней кромки подложки.
    const u = (frame.across - boxWidth) / 2;
    const v = edge + boxHeight;
    const textU = u + (boxWidth - textWidth) / 2;
    const baseV = v - STAMP.paddingPt - descent;

    // Белая подложка — чтобы текст читался, даже если под ним есть светлая рамка.
    if (frame.rotated) {
      // Верх этикетки — правый край страницы, строка читается сверху вниз.
      const right = frame.x + frame.depth;
      const top = frame.y + frame.across;
      page.drawRectangle({
        x: right - v,
        y: top - u - boxWidth,
        width: boxHeight,
        height: boxWidth,
        color: rgb(1, 1, 1),
      });
      page.drawText(text, {
        x: right - baseV,
        y: top - textU,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
        rotate: degrees(-90),
      });
    } else {
      const top = frame.y + frame.depth;
      page.drawRectangle({
        x: frame.x + u,
        y: top - v,
        width: boxWidth,
        height: boxHeight,
        color: rgb(1, 1, 1),
      });
      page.drawText(text, {
        x: frame.x + textU,
        y: top - baseV,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
      });
    }
    drew = true;
  }

  if (!drew) return pdfBytes;
  return pdf.save();
}
