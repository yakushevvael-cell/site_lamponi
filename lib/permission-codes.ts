/**
 * Права набором галочек.
 *
 * Уровни доступа («простой», «полный», «владелец») описывают доверие к
 * человеку в целом, а складские обязанности так не описываются: сборщику
 * нужно ровно своё задание, начальнику склада — снятие блокировок, и ни тому,
 * ни другому не нужны цены. Поэтому каждое право — отдельная галочка.
 *
 * Полный доступ и владелец получают все права без галочек: иначе владелец мог
 * бы случайно отобрать доступ у самого себя.
 *
 * Файл намеренно без серверных импортов — его читают и страницы, и браузер.
 */

export type PermissionCode =
  | "warehouse.pick"
  | "warehouse.tasks"
  | "warehouse.cells"
  | "warehouse.scan"
  | "warehouse.supply"
  | "warehouse.problems"
  | "warehouse.problems.release"
  | "warehouse.osv"
  | "warehouse.reports"
  | "money.view";

export type PermissionDefinition = {
  code: PermissionCode;
  label: string;
  hint: string;
  /** Право ещё не наполнено функциями — этап 4 и 5 складского модуля. */
  upcoming?: boolean;
};

export const PERMISSIONS: PermissionDefinition[] = [
  { code: "warehouse.pick", label: "Сборка по заданиям", hint: "Своё задание: артикул, ячейка, количество, кнопки «собрано» и «не найден»." },
  { code: "warehouse.tasks", label: "Задания и листы подбора", hint: "Формировать задания по площадкам и складам, выдавать сборщикам, печатать листы подбора." },
  { code: "warehouse.problems", label: "Проблемные товары", hint: "Разбор товаров, которых не нашлось: статусы, отмена заданий WB, ожидание производства." },
  { code: "warehouse.problems.release", label: "Снятие блокировки и расхождения", hint: "Вкладка «Расхождения» и возврат артикула в продажу. Только с комментарием, уровень начальника склада." },
  { code: "warehouse.cells", label: "Ячейки и раскладка", hint: "Справочник ячеек и раскладка «артикул → ячейка»." },
  { code: "warehouse.osv", label: "Загрузка ОСВ", hint: "Загружать учётные остатки из 1С. Уровень начальника склада." },
  { code: "warehouse.scan", label: "Сканирование и этикетки", hint: "Загрузка УПД, стол сканирования УИН и печать этикеток." },
  { code: "warehouse.supply", label: "Оформление поставок", hint: "Поставки на склады площадок, QR коробов, акт приёма-передачи и точки сдачи." },
  { code: "warehouse.reports", label: "Отчёты и хронометраж", hint: "Время по этапам, очередь на упаковке, потери.", upcoming: true },
  { code: "money.view", label: "Цены и суммы", hint: "Дашборды, суммы заказов и выкупов, цены в заказах. Складским сотрудникам не нужны." },
];

export const PERMISSION_CODES = PERMISSIONS.map((permission) => permission.code);

const KNOWN = new Set<string>(PERMISSION_CODES);

export function isPermissionCode(value: unknown): value is PermissionCode {
  return typeof value === "string" && KNOWN.has(value);
}

export type PermissionPreset = {
  id: string;
  label: string;
  hint: string;
  codes: PermissionCode[];
};

/** Готовые наборы под должности — чтобы не расставлять десять галочек руками. */
export const PERMISSION_PRESETS: PermissionPreset[] = [
  {
    id: "picker",
    label: "Сборщик",
    hint: "Только своё задание.",
    codes: ["warehouse.pick"],
  },
  {
    id: "storekeeper",
    label: "Кладовщик",
    hint: "Задания, листы подбора, проблемные, сканирование и поставки.",
    codes: ["warehouse.pick", "warehouse.tasks", "warehouse.problems", "warehouse.scan", "warehouse.supply"],
  },
  {
    id: "chief",
    label: "Начальник склада",
    hint: "Всё, что у кладовщика, плюс ОСВ, ячейки, снятие блокировок и отчёты.",
    codes: [
      "warehouse.pick",
      "warehouse.tasks",
      "warehouse.problems",
      "warehouse.problems.release",
      "warehouse.cells",
      "warehouse.osv",
      "warehouse.scan",
      "warehouse.supply",
      "warehouse.reports",
    ],
  },
];

/** Уровень доступа, как он называется в интерфейсе. */
export type AccessLevel = "simple" | "full" | "owner";

export function accessLevelOfRole(role: string): AccessLevel {
  if (role === "admin") return "owner";
  if (role === "manager") return "full";
  return "simple";
}

/**
 * Полный набор прав пользователя.
 * Полный доступ и владелец — все права, остальным считаются галочки.
 */
export function effectivePermissions(role: string, granted: Iterable<string>): PermissionCode[] {
  if (role === "admin" || role === "manager") return [...PERMISSION_CODES];
  const result: PermissionCode[] = [];
  for (const code of granted) if (isPermissionCode(code) && !result.includes(code)) result.push(code);
  return result;
}

export function hasPermission(permissions: Iterable<string>, code: PermissionCode) {
  for (const value of permissions) if (value === code) return true;
  return false;
}

/** Права, дающие доступ хоть к одной складской странице. */
export const WAREHOUSE_PERMISSIONS: PermissionCode[] = [
  "warehouse.pick",
  "warehouse.tasks",
  "warehouse.cells",
  "warehouse.scan",
  "warehouse.supply",
  "warehouse.problems",
  "warehouse.problems.release",
  "warehouse.reports",
];
