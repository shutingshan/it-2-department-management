import fs from "fs";
import path from "path";
import dayjs from "dayjs";
import { config } from "./config";
import { dedupe } from "./mapping";
import { ExpectedMonthSource, ExpectedMonthSourceMode, Ticket } from "./types";

// 运行期可改的配置落盘在 backend/.data/settings.json（不入 git），重启后仍生效；
// 文件不存在时回退到 .env 里的默认值
const SETTINGS_FILE = path.join(__dirname, "../.data/settings.json");

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MODES: ExpectedMonthSourceMode[] = ["monthlyPlan", "generated", "custom"];

interface PersistedSettings {
  expectedMonthSource?: Partial<ExpectedMonthSource>;
}

function readFile(): PersistedSettings {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")) as PersistedSettings;
  } catch {
    // 配置文件损坏时不应拖垮服务，回退到默认值即可
    return {};
  }
}

function writeFile(data: PersistedSettings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

let current: ExpectedMonthSource = {
  ...config.expectedMonthSource,
  ...readFile().expectedMonthSource,
};

export function getExpectedMonthSource(): ExpectedMonthSource {
  return { ...current };
}

// 返回校验错误信息，通过校验时返回 null
export function validateExpectedMonthSource(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return "配置格式不正确";
  const s = input as Partial<ExpectedMonthSource>;

  if (!MODES.includes(s.mode as ExpectedMonthSourceMode)) {
    return `来源模式取值不合法，仅支持 ${MODES.join("/")}`;
  }
  for (const key of ["pastMonths", "futureMonths"] as const) {
    const v = s[key];
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 60) {
      return `${key} 需为 0-60 之间的整数`;
    }
  }
  if (!Array.isArray(s.customMonths) || s.customMonths.some((m) => !MONTH_RE.test(m))) {
    return "自定义月份需为 YYYY-MM 格式";
  }
  if (s.mode === "custom" && s.customMonths.length === 0) {
    return "来源模式为自定义清单时，至少需要配置一个月份";
  }
  if (s.mode === "generated" && s.pastMonths === 0 && s.futureMonths === 0) {
    // 仍会生成当月一个选项，属于合法但需要提醒的边界配置，这里放行
  }
  if (typeof s.includeSubTickets !== "boolean" || typeof s.includeExistingValues !== "boolean") {
    return "includeSubTickets / includeExistingValues 需为布尔值";
  }
  return null;
}

export function updateExpectedMonthSource(next: ExpectedMonthSource): ExpectedMonthSource {
  current = {
    mode: next.mode,
    includeSubTickets: next.includeSubTickets,
    pastMonths: next.pastMonths,
    futureMonths: next.futureMonths,
    customMonths: dedupe(next.customMonths).sort(),
    includeExistingValues: next.includeExistingValues,
  };
  writeFile({ ...readFile(), expectedMonthSource: current });
  return getExpectedMonthSource();
}

// 「需方期望月度」下拉候选值：按当前配置的来源解析
export function resolveExpectedMonthOptions(tickets: Ticket[]): string[] {
  const s = current;
  let base: string[] = [];

  switch (s.mode) {
    case "monthlyPlan":
      base = tickets.flatMap((t) => [
        ...t.monthlyPlan,
        ...(s.includeSubTickets ? t.subTickets.flatMap((sub) => sub.monthlyPlan) : []),
      ]);
      break;
    case "generated": {
      const start = dayjs().subtract(s.pastMonths, "month");
      const count = s.pastMonths + s.futureMonths + 1;
      base = Array.from({ length: count }, (_, i) => start.add(i, "month").format("YYYY-MM"));
      break;
    }
    case "custom":
      base = [...s.customMonths];
      break;
  }

  // 已填写的期望月度始终并入候选，否则来源收窄后历史值会从下拉里消失、无法再选回
  if (s.includeExistingValues) {
    base.push(...(tickets.map((t) => t.expectedMonth).filter(Boolean) as string[]));
  }
  return dedupe(base).sort();
}

export function isValidMonth(v: string): boolean {
  return MONTH_RE.test(v);
}
