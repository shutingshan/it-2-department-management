import { TicketStage, TicketStatus } from "./types";

const TRIAGE_TO_DEV_STAGE: Record<string, TicketStage> = {
  开发完成: "开发中",
  实现中: "开发中",
  转测试: "测试验收",
  测试中: "测试验收",
  待验收: "测试验收",
  已验收: "测试验收",
};

/**
 * 状态与工单阶段映射规则（待用户提供"状态"与"tapd状态"完整取值域及组合规则后重写，
 * 这里先保留原有规则并补上"待处理->待分配"，"待补充资料"暂不自动推导）：
 * 已完成/已解决 -> 已完成
 * 已梳理 + 开发完成/实现中 -> 开发中
 * 已梳理 + 转测试/测试中/待验收/已验收 -> 测试验收
 * 规划中 -> 方案梳理
 * 待处理 -> 待分配
 * 已梳理（其余情况）-> 待排期
 * 关闭 -> 关闭
 * 规则命中优先级从上到下，已解决优先级最高。
 */
export function resolveStage(status: TicketStatus, devStatus: string | null): TicketStage {
  if (status === "已完成" || status === "已解决") return "已完成";
  if (status === "关闭") return "关闭";
  if (status === "待处理") return "待分配";
  if (status === "规划中") return "方案梳理";
  if (status === "已梳理") {
    if (devStatus && TRIAGE_TO_DEV_STAGE[devStatus]) {
      return TRIAGE_TO_DEV_STAGE[devStatus];
    }
    return "待排期";
  }
  return "待排期";
}

export function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

// TAPD 迭代字段可能带有"（当前迭代）"后缀（如 260710～260712（当前迭代）），展示/筛选/去重前需先截掉
export function stripCurrentIterationTag(name: string): string {
  return name.replace(/[（(]当前迭代[）)]/g, "").trim();
}
