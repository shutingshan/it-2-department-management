import { store } from "./store";
import { runFetchNew, startTapdJob, startUpdateTicketsJob } from "./routes/sync";

// 定时同步的操作人标识：用于变更日志中区分"人工点击"与"定时任务触发"
const SCHEDULED_ACTOR = "定时任务";
const TARGET_MINUTES = 18 * 60 + 30; // 北京时间 18:30

let lastRunDate: string | null = null;

function currentBeijingTime(): { dateStr: string; minutes: number } {
  const beijing = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return {
    dateStr: beijing.toISOString().slice(0, 10),
    minutes: beijing.getUTCHours() * 60 + beijing.getUTCMinutes(),
  };
}

// 每天 18:30：依次触发 获取新工单 -> 更新工单 -> 获取TAPD信息（仅未完成未关闭且有TAPD地址的数据），
// 三步均按各自既有逻辑记录"数据同步"类型的变更日志（成功/失败、失败原因），此处不重复记录
export async function runScheduledSyncChain() {
  try {
    await runFetchNew(SCHEDULED_ACTOR, "incremental");
  } catch {
    // 获取新工单失败已在 runFetchNew 内记录变更日志；继续执行后续步骤，不中断整条链路
  }

  if (!store.currentJob || store.currentJob.status !== "running") {
    const { done } = startUpdateTicketsJob(SCHEDULED_ACTOR);
    await done;
  }

  if (!store.currentJob || store.currentJob.status !== "running") {
    // 不传筛选条件：默认即为"未完成未关闭"范围，再过滤有TAPD地址的数据
    const { done } = startTapdJob(SCHEDULED_ACTOR);
    await done;
  }
}

export function startScheduler() {
  setInterval(() => {
    const { dateStr, minutes } = currentBeijingTime();
    if (minutes >= TARGET_MINUTES && lastRunDate !== dateStr) {
      lastRunDate = dateStr;
      runScheduledSyncChain().catch((e) => {
        console.error("定时同步任务执行异常:", e);
      });
    }
  }, 60 * 1000);
}
