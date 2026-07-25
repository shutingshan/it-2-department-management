import { Router } from "express";
import dayjs from "dayjs";
import { store } from "../store";
import { resolveStage } from "../mapping";
import { fetchTapdDelta } from "../adapters/tapd";
import { SyncJob } from "../store";
import { scrapeDangquyunTicketList } from "../scrapers/dangquyunScraper";
import { mapScrapedRowToTicket } from "../scrapers/dangquyunMapper";

const router = Router();

// 普通用户更新工单的时间限制：北京时间 07:00 前、11:30-12:50、18:30 后可执行；管理员无限制
function withinUpdateWindow(): boolean {
  const utcMs = Date.now();
  const beijingMs = utcMs + 8 * 60 * 60 * 1000;
  const beijing = new Date(beijingMs);
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  const before0700 = minutes < 7 * 60;
  const lunchWindow = minutes >= 11 * 60 + 30 && minutes <= 12 * 60 + 50;
  const after1830 = minutes >= 18 * 60 + 30;
  return before0700 || lunchWindow || after1830;
}

router.get("/status", (req, res) => {
  res.json({ job: store.currentJob, lastUpdateTime: store.lastUpdateTime });
});

router.post("/fetch-new", async (req, res) => {
  const { actor } = req.body as { actor: string };

  try {
    // 真实抓取当曲云工单列表（需要 backend/.env 配置好账号密码，见 .env.example）；
    // 仅增量：按"编号"跟工单中心现有数据比对，只新增工单中心里还没有的
    const result = await scrapeDangquyunTicketList();
    const existingCodes = new Set(store.tickets.map((t) => t.code));
    const newTickets = result.rows
      .map((row) => mapScrapedRowToTicket(row))
      .filter((t) => t.code && !existingCodes.has(t.code));

    store.tickets.unshift(...newTickets);
    store.addLog({
      type: "获取新工单",
      time: dayjs().format("YYYY-MM-DD HH:mm:ss"),
      actor,
      success: true,
      failReason: null,
      detail: `本次抓取 ${result.rows.length} 条（策略：${result.strategy}），增量获取新工单 ${newTickets.length} 条`,
    });
    res.json({ addedCount: newTickets.length });
  } catch (e) {
    const message = (e as Error).message ?? "未知错误";
    store.addLog({
      type: "获取新工单",
      time: dayjs().format("YYYY-MM-DD HH:mm:ss"),
      actor,
      success: false,
      failReason: message,
      detail: "获取新工单失败",
    });
    res.status(500).json({ message: `获取新工单失败：${message}` });
  }
});

let jobTimer: NodeJS.Timeout | null = null;

function stopJobTimer() {
  if (jobTimer) {
    clearInterval(jobTimer);
    jobTimer = null;
  }
}

router.post("/update-tickets", (req, res) => {
  const { actor, actorRole } = req.body as { actor: string; actorRole: string };

  if (actorRole !== "admin" && !withinUpdateWindow()) {
    return res.status(403).json({
      message: "当前不在可执行时间窗口内（北京时间 07:00 前 / 11:30-12:50 / 18:30 后，管理员不限）",
    });
  }
  if (store.currentJob?.status === "running") {
    return res.status(409).json({ message: "已有同步任务在执行中" });
  }

  // 仅对未完成未关闭工单批量更新，不逐条处理已关闭工单
  const candidates = store.tickets.filter((t) => t.stage !== "已完成" && t.stage !== "关闭");
  const job: SyncJob = {
    id: `job-${Date.now()}`,
    type: "update_tickets",
    status: "running",
    total: candidates.length,
    processed: 0,
    success: 0,
    failed: 0,
    startedAt: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    finishedAt: null,
    failReasons: [],
  };
  store.currentJob = job;

  let idx = 0;
  stopJobTimer();
  jobTimer = setInterval(async () => {
    if (job.status !== "running") {
      stopJobTimer();
      return;
    }
    const batch = candidates.slice(idx, idx + 5);
    idx += 5;
    for (const ticket of batch) {
      try {
        const delta = await fetchTapdDelta(ticket, Math.random);
        if (delta.failReason) {
          job.failed += 1;
          job.failReasons.push(`${ticket.code}: ${delta.failReason}`);
          store.addChangeLog(ticket, []);
        } else {
          if (delta.status) ticket.status = delta.status;
          if (delta.devStatus !== undefined) ticket.devStatus = delta.devStatus;
          const newStage = resolveStage(ticket.status, ticket.devStatus);
          if (newStage !== ticket.stage) {
            store.addChangeLog(ticket, [
              {
                field: "stage",
                oldValue: ticket.stage,
                newValue: newStage,
                time: dayjs().format("YYYY-MM-DD HH:mm:ss"),
                actor: "系统同步",
              },
            ]);
            ticket.stage = newStage;
            if (newStage === "已完成" && !ticket.actualCompleteTime) {
              ticket.actualCompleteTime = dayjs().format("YYYY-MM-DD");
            }
          }
          job.success += 1;
        }
      } catch {
        job.failed += 1;
        job.failReasons.push(`${ticket.code}: 未知错误`);
      }
      job.processed += 1;
    }
    if (idx >= candidates.length) {
      job.status = "done";
      job.finishedAt = dayjs().format("YYYY-MM-DD HH:mm:ss");
      store.lastUpdateTime = job.finishedAt;
      store.addLog({
        type: "更新工单",
        time: job.finishedAt,
        actor,
        success: job.failed === 0,
        failReason: job.failed ? job.failReasons.join("; ") : null,
        detail: `批量更新完成，成功 ${job.success} 条，失败 ${job.failed} 条`,
      });
      stopJobTimer();
    }
  }, 400);

  res.json({ job });
});

router.post("/terminate", (req, res) => {
  if (store.currentJob && store.currentJob.status === "running") {
    store.currentJob.status = "terminated";
    store.currentJob.finishedAt = dayjs().format("YYYY-MM-DD HH:mm:ss");
    stopJobTimer();
    store.addLog({
      type: store.currentJob.type === "sync_tapd" ? "同步TAPD" : "更新工单",
      time: store.currentJob.finishedAt,
      actor: (req.body as { actor?: string }).actor ?? "未知",
      success: false,
      failReason: "任务被手动终止",
      detail: `已处理 ${store.currentJob.processed}/${store.currentJob.total}`,
    });
  }
  res.json({ job: store.currentJob });
});

router.post("/tapd", (req, res) => {
  const { actor } = req.body as { actor: string };
  // 同步 TAPD 信息：应在更新工单完成后触发，支持终止
  const candidates = store.tickets.filter(
    (t) => t.tapdUrl && t.stage !== "已完成" && t.stage !== "关闭"
  );
  const job: SyncJob = {
    id: `job-${Date.now()}`,
    type: "sync_tapd",
    status: "running",
    total: candidates.length,
    processed: 0,
    success: 0,
    failed: 0,
    startedAt: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    finishedAt: null,
    failReasons: [],
  };
  store.currentJob = job;

  let idx = 0;
  stopJobTimer();
  jobTimer = setInterval(() => {
    if (job.status !== "running") {
      stopJobTimer();
      return;
    }
    const batch = candidates.slice(idx, idx + 5);
    idx += 5;
    for (const ticket of batch) {
      if (Math.random() < 0.05) {
        job.failed += 1;
        job.failReasons.push(`${ticket.code}: TAPD 同步失败`);
        job.processed += 1;
        continue;
      }
      // 开发人员：无子需求取 TAPD 开发人员；有子需求汇总子需求开发人员去重
      if (ticket.subTickets.length) {
        ticket.developer = Array.from(new Set(ticket.subTickets.map((s) => s.developer)));
        ticket.currentHandler = ticket.subTickets.map((s) => s.currentHandler).join("、");
        ticket.actualHours = Number(
          ticket.subTickets.reduce((sum, s) => sum + s.actualHours, 0).toFixed(1)
        );
      }
      // 若开发人员与当前处理人相同，置空开发人员并重新抓取（此处模拟保持不变，仅做一致性检查）
      if (ticket.developer.length === 1 && ticket.developer[0] === ticket.currentHandler && ticket.subTickets.length === 0) {
        ticket.developer = [];
      }
      job.success += 1;
      job.processed += 1;
    }
    if (idx >= candidates.length) {
      job.status = "done";
      job.finishedAt = dayjs().format("YYYY-MM-DD HH:mm:ss");
      store.addLog({
        type: "同步TAPD",
        time: job.finishedAt,
        actor,
        success: job.failed === 0,
        failReason: job.failed ? job.failReasons.join("; ") : null,
        detail: `同步 TAPD 完成，成功 ${job.success} 条，失败 ${job.failed} 条`,
      });
      stopJobTimer();
    }
  }, 400);

  res.json({ job });
});

export default router;
