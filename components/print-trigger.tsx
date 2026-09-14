"use client";

/**
 * Открывает диалог печати сразу при загрузке листа подбора и помечает задание
 * напечатанным. Отметка нужна хронометражу: по ней видно, сколько лист лежал
 * до начала сборки.
 */
import { useEffect, useRef } from "react";

export function PrintTrigger({ taskId }: { taskId: number }) {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void fetch("/api/warehouse/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: taskId, action: "printed" }),
    }).catch(() => undefined);
    // Небольшая задержка: иначе диалог печати открывается до того, как
    // браузер дорисовал штрихкод, и на бумаге остаётся пустое место.
    const timer = setTimeout(() => window.print(), 400);
    return () => clearTimeout(timer);
  }, [taskId]);

  return null;
}
