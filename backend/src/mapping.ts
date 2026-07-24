import { TicketStage, TicketStatus } from "./types";

const TRIAGE_TO_DEV_STAGE: Record<string, TicketStage> = {
  开发完成: "开发中",
  实现中: "开发中",
  转测试: "测试验收中",
  测试中: "测试验收中",
  待验收: "测试验收中",
  已验收: "测试验收中",
};

/**
 * 状态与工单阶段映射规则（需求文档第9节）：
 * 已完成/已解决 -> 已完成
 * 已梳理 + 开发完成/实现中 -> 开发中
 * 已梳理 + 转测试/测试中/待验收/已验收 -> 测试验收中
 * 规划中 -> 方案梳理
 * 已梳理（其余情况）-> 待排期
 * 关闭 -> 关闭
 * 规则命中优先级从上到下，已解决优先级最高。
 */
export function resolveStage(status: TicketStatus, devStatus: string | null): TicketStage {
  if (status === "已完成" || status === "已解决") return "已完成";
  if (status === "关闭") return "关闭";
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
