import dayjs from "dayjs";
import { dedupe } from "./mapping";
import { ExpectedMonthSource, ExpectedMonthSourceMode, Ticket } from "./types";

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const MODES: ExpectedMonthSourceMode[] = ["monthlyPlan", "generated", "custom"];

// 默认沿用月度计划字段，跟改动前的行为一致；管理员可在「范围配置」页改成另外两种
export const DEFAULT_EXPECTED_MONTH_SOURCE = (): ExpectedMonthSource => ({
  mode: "monthlyPlan",
  includeSubTickets: true,
  pastMonths: 3,
  futureMonths: 12,
  customMonths: [],
  includeExistingValues: true,
});

/** 返回校验错误信息，通过校验时返回 null */
export function validateExpectedMonthSource(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return "配置格式不正确";
  const s = input as Partial<ExpectedMonthSource>;

  if (!MODES.includes(s.mode as ExpectedMonthSourceMode)) {
    return `取值来源不合法，仅支持 ${MODES.join("/")}`;
  }
  for (const key of ["pastMonths", "futureMonths"] as const) {
    const v = s[key];
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 60) {
      return `${key === "pastMonths" ? "往前" : "往后"}生成的月份数需为 0-60 之间的整数`;
    }
  }
  if (!Array.isArray(s.customMonths) || s.customMonths.some((m) => !MONTH_RE.test(m))) {
    return "自定义月份需为 YYYY-MM 格式";
  }
  if (s.mode === "custom" && s.customMonths.length === 0) {
    return "取值来源为自定义清单时，至少需要配置一个月份";
  }
  if (typeof s.includeSubTickets !== "boolean" || typeof s.includeExistingValues !== "boolean") {
    return "开关项取值需为布尔值";
  }
  return null;
}

export function normalizeExpectedMonthSource(input: ExpectedMonthSource): ExpectedMonthSource {
  return {
    mode: input.mode,
    includeSubTickets: input.includeSubTickets,
    pastMonths: input.pastMonths,
    futureMonths: input.futureMonths,
    customMonths: dedupe(input.customMonths).sort(),
    includeExistingValues: input.includeExistingValues,
  };
}

/**
 * 「需方期望月度」的下拉候选值。
 *
 * 刻意不跟其余 facets 一样从当前筛选结果里取：那样只能选到系统里已经出现过的月份，
 * 需方想填一个还没有任何工单排到的月份就填不进去。三种来源按配置切换：
 *   monthlyPlan：取自工单已有的月度计划字段，跟排期口径保持一致
 *   generated：以当前月份为基准前后各生成若干个月，不依赖已有数据
 *   custom：只允许选管理员维护的那份清单，适合按年度排期固定口径
 */
export function resolveExpectedMonthOptions(
  tickets: Ticket[],
  source: ExpectedMonthSource
): string[] {
  let base: string[] = [];

  switch (source.mode) {
    case "monthlyPlan":
      base = tickets.flatMap((t) => [
        ...t.monthlyPlan,
        ...(source.includeSubTickets ? t.subTickets.flatMap((s) => s.monthlyPlan) : []),
      ]);
      break;
    case "generated": {
      const start = dayjs().subtract(source.pastMonths, "month");
      const count = source.pastMonths + source.futureMonths + 1;
      base = Array.from({ length: count }, (_, i) => start.add(i, "month").format("YYYY-MM"));
      break;
    }
    case "custom":
      base = [...source.customMonths];
      break;
  }

  // 已填写的值始终并入候选，否则来源一收窄，历史值就从下拉里消失、想改回去都点不到
  if (source.includeExistingValues) {
    base.push(...(tickets.map((t) => t.expectedMonth).filter(Boolean) as string[]));
  }
  // 月度计划里可能混入非 YYYY-MM 的手输值（该字段是 tags 模式，允许自由输入），
  // 这里统一挡掉，避免脏值进到期望月度的下拉
  return dedupe(base.filter((m) => MONTH_RE.test(m))).sort();
}
