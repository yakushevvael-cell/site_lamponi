/**
 * Структурированная часть ошибки сверки УПД.
 *
 * Раньше в problems_json лежал только массив строк. Для кнопки «Открепить»
 * нужны также УИН и id прежнего задания, поэтому новые записи хранят объект,
 * а старый формат продолжаем читать без миграции базы.
 */

/** @param {{ uin: string, taskId: number, taskNumber: string | null }} conflict */
export function foreignUinProblem(conflict) {
  return `УИН ${conflict.uin} уже закреплён за заданием ${conflict.taskNumber ?? conflict.taskId}.`;
}

/**
 * @param {string | null | undefined} value
 * @returns {{
 *   problems: string[],
 *   conflicts: Array<{ uin: string, taskId: number, taskNumber: string | null }>
 * }}
 */
export function parseUpdUploadDetails(value) {
  try {
    const parsed = value ? JSON.parse(value) : [];
    if (Array.isArray(parsed)) {
      return { problems: parsed.map(String), conflicts: [] };
    }
    if (!parsed || typeof parsed !== "object") return { problems: [], conflicts: [] };

    const problems = Array.isArray(parsed.problems) ? parsed.problems.map(String) : [];
    const conflicts = Array.isArray(parsed.conflicts)
      ? parsed.conflicts.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const uin = String(entry.uin ?? "").trim();
        const taskId = Number(entry.taskId);
        if (!uin || !Number.isFinite(taskId) || taskId <= 0) return [];
        return [{
          uin,
          taskId: Math.trunc(taskId),
          taskNumber: typeof entry.taskNumber === "string" && entry.taskNumber.trim()
            ? entry.taskNumber.trim()
            : null,
        }];
      })
      : [];
    return { problems, conflicts };
  } catch {
    return { problems: [], conflicts: [] };
  }
}

/**
 * @param {string[]} problems
 * @param {Array<{ uin: string, taskId: number, taskNumber: string | null }>} conflicts
 */
export function serializeUpdUploadDetails(problems, conflicts) {
  return JSON.stringify({
    problems: problems.slice(0, 200).map(String),
    conflicts: conflicts.slice(0, 200),
  });
}

/**
 * После открепления убираем только этот конфликт. Остальные расхождения УПД
 * остаются на экране до следующей загрузки.
 *
 * @param {{
 *   problems: string[],
 *   conflicts: Array<{ uin: string, taskId: number, taskNumber: string | null }>
 * }} details
 * @param {string} uin
 */
export function removeUpdConflict(details, uin) {
  const removed = details.conflicts.filter((conflict) => conflict.uin === uin);
  const removedProblems = new Set(removed.map(foreignUinProblem));
  return {
    problems: details.problems.filter((problem) => !removedProblems.has(problem)),
    conflicts: details.conflicts.filter((conflict) => conflict.uin !== uin),
  };
}
