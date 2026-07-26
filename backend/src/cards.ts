import dayjs, { Dayjs } from "dayjs";
import { Ticket } from "./types";

export const PUBLIC_POOL_ITERATION = "IT二部公共需求池";

export interface CardDef {
  id: string;
  parentId: string | null;
  label: string;
  description: string | null; // null 表示不显示问号说明
  red: boolean;
  match: (t: Ticket, now: Dayjs) => boolean;
}

const NOT_DONE_STAGES: Ticket["stage"][] = ["已完成", "关闭"];
const notDoneNotClosed = (t: Ticket) => !NOT_DONE_STAGES.includes(t.stage);

// 提交时间/预计完成(梳理)时间只有日期精度比较时，统一按天数差计算
function daysBetween(now: Dayjs, dateStr: string | null): number | null {
  if (!dateStr) return null;
  return now.startOf("day").diff(dayjs(dateStr).startOf("day"), "day");
}

export const CARD_DEFS: CardDef[] = [
  {
    id: "total",
    parentId: null,
    label: "总工单",
    description: null,
    red: false,
    match: () => true,
  },
  {
    id: "not-done",
    parentId: null,
    label: "未完成未关闭",
    description: null,
    red: false,
    match: (t) => notDoneNotClosed(t),
  },
  {
    id: "high-priority",
    parentId: "not-done",
    label: "High/High High",
    description: "优先级=High或者High High的工单数量",
    red: false,
    match: (t) => notDoneNotClosed(t) && (t.priority === "High" || t.priority === "High High"),
  },
  {
    id: "urgent",
    parentId: "not-done",
    label: "紧急/急",
    description: "紧急字段有值的工单数",
    red: true,
    match: (t) => notDoneNotClosed(t) && t.urgent === true,
  },
  {
    id: "unassigned",
    parentId: null,
    label: "待分配",
    description: "负责人还未分配的工单数",
    red: false,
    match: (t) => t.stage === "待分配",
  },
  {
    id: "unassigned-near",
    parentId: "unassigned",
    label: "2天内超期",
    description: "负责人接收工单5天后还未分配",
    red: false,
    match: (t, now) => {
      if (t.stage !== "待分配") return false;
      const d = daysBetween(now, t.submittedAt);
      return d !== null && d >= 5 && d < 7;
    },
  },
  {
    id: "unassigned-overdue",
    parentId: "unassigned",
    label: "已超期",
    description: "负责人接收工单超7天还未分配",
    red: true,
    match: (t, now) => {
      if (t.stage !== "待分配") return false;
      const d = daysBetween(now, t.submittedAt);
      return d !== null && d > 7;
    },
  },
  {
    id: "need-info",
    parentId: null,
    label: "待补充资料",
    description: "待需求方补充资料",
    red: false,
    match: (t) => t.stage === "待补充资料",
  },
  {
    id: "triage",
    parentId: null,
    label: "方案梳理",
    description: null,
    red: false,
    match: (t) => t.stage === "方案梳理",
  },
  {
    id: "triage-near",
    parentId: "triage",
    label: "5天内超期",
    description: "五天内到预计梳理完成时间",
    red: false,
    match: (t, now) => {
      if (t.stage !== "方案梳理") return false;
      const d = daysBetween(now, t.expectedTriageTime);
      return d !== null && d >= -5 && d <= 0;
    },
  },
  {
    id: "triage-overdue",
    parentId: "triage",
    label: "梳理已超期",
    description: "已超预计梳理完成时间",
    red: true,
    match: (t, now) => {
      if (t.stage !== "方案梳理") return false;
      const d = daysBetween(now, t.expectedTriageTime);
      return d !== null && d > 0;
    },
  },
  {
    id: "scheduling",
    parentId: null,
    label: "待排期",
    description: "未纳入任何迭代（迭代为IT二部公共需求池不算纳入迭代）",
    red: false,
    match: (t) => t.stage === "待排期",
  },
  {
    id: "scheduling-near",
    parentId: "scheduling",
    label: "14天内超期",
    description: "未纳入迭代（迭代为IT二部公共需求池不算纳入迭代），14天内到预计完成时间的工单数",
    red: false,
    match: (t, now) => {
      if (t.stage !== "待排期") return false;
      const d = daysBetween(now, t.expectedCompleteTime);
      return d !== null && d >= -14 && d <= 0;
    },
  },
  {
    id: "scheduling-overdue",
    parentId: "scheduling",
    label: "待排已超期",
    description: "未纳入迭代（迭代为IT二部公共需求池不算纳入迭代），已超预计完成时间的工单数",
    red: true,
    match: (t, now) => {
      if (t.stage !== "待排期") return false;
      const d = daysBetween(now, t.expectedCompleteTime);
      return d !== null && d > 0;
    },
  },
  {
    id: "scheduled",
    parentId: null,
    label: "已排期待开发",
    description: "已纳入迭代（迭代为IT二部公共需求池不算纳入迭代），工单阶段为已排期",
    red: false,
    match: (t) => t.stage === "已排期",
  },
  {
    id: "developing",
    parentId: null,
    label: "开发中",
    description: null,
    red: false,
    match: (t) => t.stage === "开发中",
  },
  {
    id: "testing",
    parentId: null,
    label: "测试验收",
    description: null,
    red: false,
    match: (t) => t.stage === "测试验收",
  },
  {
    id: "testing-near",
    parentId: "testing",
    label: "4天内超期",
    description: "工单阶段为测试验收且预计完成时间-当前日期在4天内的工单数",
    red: false,
    match: (t, now) => {
      if (t.stage !== "测试验收") return false;
      const d = daysBetween(now, t.expectedCompleteTime);
      return d !== null && d >= -4 && d <= 0;
    },
  },
  {
    id: "testing-overdue",
    parentId: "testing",
    label: "验收已超期",
    description: "工单阶段为测试验收且已超预计完成时间的工单数",
    red: true,
    match: (t, now) => {
      if (t.stage !== "测试验收") return false;
      const d = daysBetween(now, t.expectedCompleteTime);
      return d !== null && d > 0;
    },
  },
  {
    id: "done-closed",
    parentId: null,
    label: "已完成及关闭",
    description: null,
    red: false,
    match: (t) => t.stage === "已完成" || t.stage === "关闭",
  },
];

export interface CardStat {
  id: string;
  parentId: string | null;
  label: string;
  description: string | null;
  red: boolean;
  count: number;
}

export function computeCardStats(tickets: Ticket[], now: Dayjs = dayjs()): CardStat[] {
  return CARD_DEFS.map((def) => ({
    id: def.id,
    parentId: def.parentId,
    label: def.label,
    description: def.description,
    red: def.red,
    count: tickets.filter((t) => def.match(t, now)).length,
  }));
}

export function filterByCard(tickets: Ticket[], cardId: string, now: Dayjs = dayjs()): Ticket[] {
  const def = CARD_DEFS.find((c) => c.id === cardId);
  if (!def) return tickets;
  return tickets.filter((t) => def.match(t, now));
}
