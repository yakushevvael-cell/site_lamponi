"use client";

/**
 * Печать этикеток поставки: диалог печати открывается сам, когда все картинки
 * догрузились. Иначе на термоленту уходит пустая этикетка — браузер печатает
 * страницу раньше, чем пришёл PNG.
 *
 * Страница открывается в скрытом окне на странице «Поставки» или отдельной
 * вкладкой; в отдельной вкладке после печати она закрывается сама.
 */
import { useEffect, useRef } from "react";

export function LabelPrintTrigger() {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    const images = Array.from(document.images);
    const ready = images.map((image) => (image.complete && image.naturalWidth > 0
      ? Promise.resolve()
      : image.decode().catch(() => undefined)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    void Promise.all(ready).then(() => {
      timer = setTimeout(() => {
        const standalone = window.parent === window;
        if (standalone) window.addEventListener("afterprint", () => window.close(), { once: true });
        window.print();
      }, 150);
    });
    return () => { if (timer) clearTimeout(timer); };
  }, []);

  return null;
}
