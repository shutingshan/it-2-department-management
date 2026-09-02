import dayjs from "dayjs";
import { Ticket } from "./types";

/**
 * 需求分析看板的取数与统计口径。
 *
 * 用途是对内汇报「各需求模块的改动频率」，所以取的是库内全量需求数据，
 * 不走工单中心那套显示范围配置——否则汇报口径会随页面配置漂移。
 *
 * 抽成纯函数：看板接口与导出接口都用它，两边数字天然一致。
 */

export const REQUIREMENT_CATEGORY = "需求";

// 这个看板一律不看的状态：关闭（已终止）、新制（当曲云上刚提交、还没人接，
// 完成时间都还没定，计入频率会把间隔算歪）。所有统计与条数都按这个口径过滤
const EXCLUDED_STATUSES = ["关闭", "新制"];

// 完成口径：已解决/已完成算完成，其余算未完成。跟时间点取法保持一致
const DONE_STATUSES = ["已解决", "已完成"];

function isDone(status: string): boolean {
  return DONE_STATUSES.includes(status);
}

// 频率档位的月份阈值换算成天数。用固定 30 天/月而不是按自然月算：
// 平均间隔本身是个天数小数，跟自然月比较需要一个确定的换算，30/90 天口径简单且好解释
const DAYS_PER_MONTH = 30;
const HIGH_FREQ_MAX_DAYS = DAYS_PER_MONTH; // < 1 个月
const NORMAL_FREQ_MAX_DAYS = DAYS_PER_MONTH * 3; // <= 3 个月

export type RequirementFrequency = "高频" | "正常" | "低频";

/** 明细行：点开某个模块时看到的工单清单 */
export interface RequirementTicketDetail {
  code: string; // 工单编码
  owningApp: string;
  module: string; // 归一后的需求模块，跟汇总行对得上
  status: string;
  expectedCompleteTime: string | null; // 期望完成时间
  actualCompleteTime: string | null; // 实际完成时间
  itHandler: string;
  requester: string;
  // 该条实际参与频率计算的时间点。两个完成时间都有值时，看这一列才知道用的是哪个
  timePoint: string;
  // 该条的需求模块为空、模块列的值是拿归属应用顶上的
  fromOwningApp: boolean;
}

export interface RequirementModuleRow {
  module: string;
  count: number;
  firstTime: string; // 该模块最早的时间点 YYYY-MM-DD
  lastTime: string; // 最晚的时间点
  // 平均间隔天数 =（最晚 − 最早）/（条数 − 1）；只有 1 条时无间隔可算，为 null
  avgIntervalDays: number | null;
  frequency: RequirementFrequency;
  // 这一行的模块名整组都来自归属应用（组内工单的需求模块全为空）。
  // 组内有真实需求模块时为 false，不给汇报制造噪音
  fromOwningApp: boolean;
  // 该模块下参与统计的工单明细，按时间点升序。数据量是需求工单级别，
  // 直接随汇总一起返回，省掉点开明细时的二次请求，导出也复用同一份
  tickets: RequirementTicketDetail[];
}

export interface RequirementModuleStats {
  rows: RequirementModuleRow[];
  years: number[]; // 库内有数据的年份，供页面下拉
  total: number; // 纳入统计的需求总条数
  doneCount: number; // 其中已解决/已完成的条数
  undoneCount: number; // 其中非已解决、非已完成的条数
  // 分类是需求、也没关闭，但两个时间字段都为空，落不到时间轴上，只能排除
  excludedNoTime: number;
  summary: Record<RequirementFrequency, number>;
}

// 需求模块没取到值时，当曲云同步会写成这个占位符（见 dangquyunMapper），
// 跟空字符串一样都按"没填"处理
const EMPTY_PLACEHOLDER = "-";

/**
 * 统计用的模块取值：
 *   1. 需求模块有值时，带「/」只要最后一级（当曲云上常写成「订单中心/支付模块」）
 *   2. 需求模块为空（含占位符「-」、以及「订单中心/」这种切完为空的）时，退回按归属应用统计
 *   3. 归属应用也为空时才落到占位符
 *
 * 返回 fromOwningApp 是为了在页面和导出里标出这一行是拿归属应用顶上的——
 * 不标的话，汇报时看到「需求模块」列里出现一个应用名会以为是数据错了
 */
export function resolveModuleKey(t: Pick<Ticket, "module" | "owningApp">): {
  module: string;
  fromOwningApp: boolean;
} {
  const raw = (t.module ?? "").trim();
  if (raw && raw !== EMPTY_PLACEHOLDER) {
    const idx = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("／"));
    const tail = (idx < 0 ? raw : raw.slice(idx + 1)).trim();
    if (tail && tail !== EMPTY_PLACEHOLDER) return { module: tail, fromOwningApp: false };
  }
  const app = (t.owningApp ?? "").trim();
  return { module: app && app !== EMPTY_PLACEHOLDER ? app : EMPTY_PLACEHOLDER, fromOwningApp: true };
}

/**
 * 工单落在时间轴上的时间点：
 * 已解决/已完成的按「实际完成时间」，其余按「预计完成时间」。
 * 两者都没有则返回 null，该工单无法参与统计。
 */
export function resolveTimePoint(t: Ticket): string | null {
  const raw = isDone(t.status) ? t.actualCompleteTime : t.expectedCompleteTime;
  if (!raw || !raw.trim()) return null;
  const d = dayjs(raw.trim());
  return d.isValid() ? d.format("YYYY-MM-DD") : null;
}

function classify(count: number, avgIntervalDays: number | null): RequirementFrequency {
  // 只有 1 条需求的模块没有间隔可算，按约定直接归低频
  if (count <= 1 || avgIntervalDays === null) return "低频";
  if (avgIntervalDays < HIGH_FREQ_MAX_DAYS) return "高频";
  if (avgIntervalDays <= NORMAL_FREQ_MAX_DAYS) return "正常";
  return "低频";
}

/**
 * @param year 指定年份时，只用落在该年的需求参与计算（条数与间隔都只看当年）；
 *             传 null 表示整体查看，用全部年份的数据
 */
export function computeRequirementModuleStats(
  tickets: Ticket[],
  year: number | null
): RequirementModuleStats {
  const candidates = tickets.filter(
    (t) => t.category?.trim() === REQUIREMENT_CATEGORY && !EXCLUDED_STATUSES.includes(t.status)
  );

  const years = new Set<number>();
  let excludedNoTime = 0;
  // 模块 -> 该模块参与统计的工单明细（含时间点）
  const byModule = new Map<string, RequirementTicketDetail[]>();

  for (const t of candidates) {
    const point = resolveTimePoint(t);
    if (!point) {
      excludedNoTime += 1;
      continue;
    }
    years.add(Number(point.slice(0, 4)));
    if (year !== null && Number(point.slice(0, 4)) !== year) continue;

    const { module, fromOwningApp } = resolveModuleKey(t);
    const detail: RequirementTicketDetail = {
      code: t.code,
      owningApp: t.owningApp,
      module,
      status: t.status,
      expectedCompleteTime: t.expectedCompleteTime,
      actualCompleteTime: t.actualCompleteTime,
      itHandler: t.itHandler,
      requester: t.requester,
      timePoint: point,
      fromOwningApp,
    };
    const list = byModule.get(module);
    if (list) list.push(detail);
    else byModule.set(module, [detail]);
  }

  const rows: RequirementModuleRow[] = [];
  let total = 0;
  let doneCount = 0;
  for (const [module, details] of byModule) {
    details.sort((a, b) => a.timePoint.localeCompare(b.timePoint));
    const count = details.length;
    total += count;
    doneCount += details.filter((d) => isDone(d.status)).length;
    const first = details[0].timePoint;
    const last = details[count - 1].timePoint;
    const avgIntervalDays =
      count > 1 ? Number((dayjs(last).diff(dayjs(first), "day") / (count - 1)).toFixed(1)) : null;
    rows.push({
      module,
      count,
      firstTime: first,
      lastTime: last,
      avgIntervalDays,
      frequency: classify(count, avgIntervalDays),
      fromOwningApp: details.every((d) => d.fromOwningApp),
      tickets: details,
    });
  }

  // 汇报时最关心改得勤的模块：先按条数多的排，条数相同按平均间隔短的排
  rows.sort((a, b) => b.count - a.count || (a.avgIntervalDays ?? Infinity) - (b.avgIntervalDays ?? Infinity));

  const summary: Record<RequirementFrequency, number> = { 高频: 0, 正常: 0, 低频: 0 };
  rows.forEach((r) => (summary[r.frequency] += 1));

  return {
    rows,
    years: Array.from(years).sort((a, b) => b - a),
    total,
    doneCount,
    undoneCount: total - doneCount,
    excludedNoTime,
    summary,
  };
}
