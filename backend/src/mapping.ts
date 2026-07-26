import { IterationRef, TicketStage, TicketStatus } from "./types";

const PUBLIC_POOL_ITERATION = "IT二部公共需求池";

// TAPD状态 -> 工单阶段（仅在"已梳理"且已纳入真实迭代时生效）
const SCHEDULED_DEV_STATUS: Record<string, TicketStage> = {
  已规划: "已排期",
  已评审: "已排期",
  实现中: "开发中",
  开发完成: "开发中",
  转测试: "测试验收",
  测试中: "测试验收",
  待验收: "测试验收",
  已验收: "测试验收",
};

// 迭代字段是否已纳入"真实"迭代：为空、或仅有"IT二部公共需求池"均视为未纳入迭代
function hasRealIteration(iterations: IterationRef[]): boolean {
  return iterations.some((i) => stripCurrentIterationTag(i.name) !== PUBLIC_POOL_ITERATION);
}

/**
 * 状态/TAPD状态/迭代 -> 工单阶段 映射规则：
 * 已解决/已完成 -> 已完成
 * 关闭 -> 关闭
 * 梳理中 -> 方案梳理
 * 已梳理 + 迭代为空或仅为"IT二部公共需求池"（未纳入迭代） -> 待排期
 * 已梳理 + 已纳入迭代 + TAPD状态=已规划/已评审 -> 已排期（待开发）
 * 已梳理 + 已纳入迭代 + TAPD状态=实现中/开发完成 -> 开发中
 * 已梳理 + 已纳入迭代 + TAPD状态=转测试/测试中/待验收/已验收 -> 测试验收
 * 已梳理 + 已纳入迭代 + TAPD状态为其余情况（含尚未同步） -> 已排期（已纳入迭代，开发状态待同步）
 * 以下为规则未覆盖的原始状态值，沿用此前口径：
 * 待处理 -> 待分配；规划中 -> 方案梳理；其余未知状态 -> 待排期
 * 规则命中优先级从上到下。
 */
export function resolveStage(
  status: TicketStatus,
  devStatus: string | null,
  iterations: IterationRef[]
): TicketStage {
  if (status === "已完成" || status === "已解决") return "已完成";
  if (status === "关闭") return "关闭";
  if (status === "梳理中") return "方案梳理";
  if (status === "已梳理") {
    if (!hasRealIteration(iterations)) return "待排期";
    if (devStatus && SCHEDULED_DEV_STATUS[devStatus]) return SCHEDULED_DEV_STATUS[devStatus];
    return "已排期";
  }
  if (status === "待处理") return "待分配";
  if (status === "规划中") return "方案梳理";
  return "待排期";
}

export function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

// TAPD 迭代字段可能带有"（当前迭代）"后缀（如 260710～260712（当前迭代）），展示/筛选/去重前需先截掉
export function stripCurrentIterationTag(name: string): string {
  return name.replace(/[（(]当前迭代[）)]/g, "").trim();
}
