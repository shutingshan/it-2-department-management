/**
 * TAPD 适配器（当前为演示用 mock 实现）。
 * 真实接入时，替换本文件内部实现为 TAPD 开放平台 API 调用（需求库 API Key + Workspace ID），
 * 对外暴露的函数签名保持不变，上层同步逻辑无需改动。
 */
import { Ticket } from "../types";

export interface TapdDelta {
  status?: Ticket["status"];
  devStatus?: string | null;
  developer?: string[];
  currentHandler?: string;
  monthlyPlan?: string[];
  actualHours?: number;
  actualCompleteTime?: string | null;
  failReason?: string | null;
}

const DEV_STATUS_POOL = ["开发完成", "实现中", "转测试", "测试中", "待验收", "已验收"];

export async function fetchTapdDelta(ticket: Ticket, rand: () => number): Promise<TapdDelta> {
  // 模拟网络延迟
  await new Promise((r) => setTimeout(r, 5));

  if (!ticket.tapdUrl) {
    return {};
  }

  if (rand() < 0.06) {
    return { failReason: "TAPD 接口超时，请稍后重试" };
  }

  const delta: TapdDelta = {};
  if (ticket.status === "已梳理" && rand() < 0.3) {
    delta.devStatus = DEV_STATUS_POOL[Math.floor(rand() * DEV_STATUS_POOL.length)];
  }
  if (rand() < 0.1) {
    delta.status = "已解决";
  }
  return delta;
}

export async function fetchNewTapdTickets(rand: () => number): Promise<number> {
  await new Promise((r) => setTimeout(r, 20));
  return Math.floor(rand() * 3);
}
