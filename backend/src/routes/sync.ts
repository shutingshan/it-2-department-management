import { Router } from "express";
import dayjs from "dayjs";
import { store } from "../store";
import { resolveStage } from "../mapping";
import { fetchTapdDelta } from "../adapters/tapd";
import { SyncJob } from "../store";
import { ScrapedRow, scrapeDangquyunTicketList } from "../scrapers/dangquyunScraper";
import { mapScrapedRowToTicket } from "../scrapers/dangquyunMapper";
import { fetchTapdStoryFields, TapdStoryFields } from "../scrapers/tapdApi";
import { scrapeTapdStoryFieldsViaBrowser } from "../scrapers/tapdScraper";
import { config } from "../config";
import { applyFilters, parseQuery, TicketQuery } from "../filter";
import { Ticket } from "../types";

// TAPD 取数入口：按 .env 里 TAPD_FETCH_MODE 在 开放平台API / 浏览器页面爬取 两种方式间切换，
// 两种方式返回同一套字段结构，后续的字段应用/阶段重算逻辑完全一致
function fetchTapdFields(tapdUrl: string): Promise<TapdStoryFields> {
  return config.tapd.fetchMode === "browser"
    ? scrapeTapdStoryFieldsViaBrowser(tapdUrl)
    : fetchTapdStoryFields(tapdUrl);
}

// 按工单中心当前筛选条件圈定候选工单；未传筛选条件时回退到"全部未完成/未关闭工单"；
// 无论是否传筛选条件，均只对"未完成未关闭"的工单批量处理，不逐条处理已完成/已关闭的工单
function resolveCandidates(filters: unknown): Ticket[] {
  const hasFilters = filters && typeof filters === "object" && Object.keys(filters as object).length > 0;
  const base = hasFilters
    ? applyFilters(store.tickets, parseQuery(filters as Record<string, unknown>) as TicketQuery)
    : store.tickets;
  return base.filter((t) => t.stage !== "已完成" && t.stage !== "关闭");
}

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

// 逐行落库：新增/覆盖更新工单中心数据，单行失败不影响其余行；抽成纯函数便于独立单测
export function applyScrapedRows(rows: ScrapedRow[], isFull: boolean) {
  const existingByCode = new Map(store.tickets.map((t) => [t.code, t]));
  let addedCount = 0;
  let updatedCount = 0;
  let failedCount = 0;
  const failReasons: string[] = [];

  for (const row of rows) {
    const code = row["编号"]?.trim();
    if (!code) {
      failedCount += 1;
      failReasons.push("(无编号): 找不到该工单编码");
      continue;
    }
    try {
      const existing = existingByCode.get(code);
      if (!existing) {
        store.tickets.unshift(mapScrapedRowToTicket(row));
        addedCount += 1;
      } else if (isFull) {
        const title = row["标题"]?.trim();
        if (!title) {
          throw new Error("标题字段获取失败");
        }
        Object.assign(existing, mapScrapedRowToTicket(row, existing));
        updatedCount += 1;
        existing.dangquyunErrorNote = null;
      }
    } catch (e) {
      failedCount += 1;
      const reason = (e as Error).message ?? "数据解析失败";
      failReasons.push(`${code}: ${reason}`);
      const existing = existingByCode.get(code);
      if (existing) {
        existing.dangquyunErrorNote = { time: dayjs().format("YYYY-MM-DD HH:mm:ss"), message: reason };
      }
    }
  }

  return { addedCount, updatedCount, failedCount, failReasons };
}

// 获取新工单没有进度轮询的 job 机制，容易在等待时间变长后被误以为"没反应"而重复点击，
// 导致两次抓取同时跑、共用同一份浏览器登录态文件互相干扰；这里用一个模块级标记防止并发执行
let fetchNewRunning = false;

// 获取新工单：供路由与定时任务共用；失败时已在此处记录变更日志并向上抛出。
// 完成后会把结果写入 store.currentJob（type: fetch_new），供前端沿用既有的悬浮进度弹窗展示
export async function runFetchNew(actor: string, mode?: "incremental" | "full") {
  if (fetchNewRunning) {
    throw new Error("已有获取新工单任务在执行中，请等待其完成后再试");
  }
  fetchNewRunning = true;
  const isFull = mode === "full";
  const startedAt = dayjs().format("YYYY-MM-DD HH:mm:ss");
  try {
    // 真实抓取当曲云工单列表（需要 backend/.env 配置好账号密码，见 .env.example）；
    // 增量模式：按"编号"跟工单中心现有数据比对，只新增工单中心里还没有的；
    // 全量模式（用于数据初始化）：已存在的工单也会用当曲云最新数据覆盖已同步字段
    const result = await scrapeDangquyunTicketList();
    const { addedCount, updatedCount, failedCount, failReasons } = applyScrapedRows(result.rows, isFull);

    const finishedAt = dayjs().format("YYYY-MM-DD HH:mm:ss");
    store.currentJob = {
      id: `job-${Date.now()}`,
      type: "fetch_new",
      status: "done",
      total: addedCount + updatedCount + failedCount,
      processed: addedCount + updatedCount + failedCount,
      success: addedCount + updatedCount,
      failed: failedCount,
      startedAt,
      finishedAt,
      failReasons,
    };

    store.addLog({
      type: "获取新工单",
      time: finishedAt,
      actor,
      success: failedCount === 0,
      failReason: failedCount ? failReasons.join("; ") : null,
      detail: `本次抓取 ${result.pageCount} 页共 ${result.rows.length} 条（策略：${result.strategy}），新增 ${addedCount} 条${
        isFull ? `，覆盖更新 ${updatedCount} 条` : ""
      }，更新异常 ${failedCount} 条`,
    });
    return { addedCount, updatedCount, failedCount, failReasons };
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
    throw e;
  } finally {
    fetchNewRunning = false;
  }
}

router.post("/fetch-new", async (req, res) => {
  const { actor, mode } = req.body as { actor: string; mode?: "incremental" | "full" };
  try {
    const result = await runFetchNew(actor, mode);
    res.json({ ...result, job: store.currentJob });
  } catch (e) {
    res.status(500).json({ message: `获取新工单失败：${(e as Error).message ?? "未知错误"}` });
  }
});

let jobTimer: NodeJS.Timeout | null = null;
let jobDoneResolver: ((job: SyncJob) => void) | null = null;

function stopJobTimer() {
  if (jobTimer) {
    clearInterval(jobTimer);
    jobTimer = null;
  }
}

// 结束当前任务（正常完成或被手动终止均会走到这里），并唤醒等待中的调用方（如定时任务链）
function finishJob(job: SyncJob) {
  stopJobTimer();
  if (jobDoneResolver) {
    const resolve = jobDoneResolver;
    jobDoneResolver = null;
    resolve(job);
  }
}

// 更新工单：供路由与定时任务共用。done 在任务完成（含被终止）时 resolve，便于定时任务链式等待
export function startUpdateTicketsJob(actor: string, filters?: unknown): { job: SyncJob; done: Promise<SyncJob> } {
  const candidates = resolveCandidates(filters);
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

  const done = new Promise<SyncJob>((resolve) => {
    jobDoneResolver = resolve;
  });

  let idx = 0;
  stopJobTimer();
  jobTimer = setInterval(async () => {
    if (job.status !== "running") {
      finishJob(job);
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
          const newStage = resolveStage(ticket.status, ticket.devStatus, ticket.iterations);
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
      finishJob(job);
    }
  }, 400);

  return { job, done };
}

router.post("/update-tickets", (req, res) => {
  const { actor, actorRole, filters } = req.body as { actor: string; actorRole: string; filters?: unknown };

  if (actorRole !== "admin" && !withinUpdateWindow()) {
    return res.status(403).json({
      message: "当前不在可执行时间窗口内（北京时间 07:00 前 / 11:30-12:50 / 18:30 后，管理员不限）",
    });
  }
  if (store.currentJob?.status === "running") {
    return res.status(409).json({ message: "已有同步任务在执行中" });
  }

  const { job } = startUpdateTicketsJob(actor, filters);
  res.json({ job });
});

router.post("/terminate", (req, res) => {
  if (store.currentJob && store.currentJob.status === "running") {
    store.currentJob.status = "terminated";
    store.currentJob.finishedAt = dayjs().format("YYYY-MM-DD HH:mm:ss");
    store.addLog({
      type: store.currentJob.type === "sync_tapd" ? "同步TAPD" : "更新工单",
      time: store.currentJob.finishedAt,
      actor: (req.body as { actor?: string }).actor ?? "未知",
      success: false,
      failReason: "任务被手动终止",
      detail: `已处理 ${store.currentJob.processed}/${store.currentJob.total}`,
    });
    finishJob(store.currentJob);
  }
  res.json({ job: store.currentJob });
});

// 把抓到的TAPD字段应用到工单上并按需重新计算工单阶段；批量任务和单条同步共用同一份逻辑，
// 避免两处各写一套导致字段口径不一致
function applyTapdFields(ticket: Ticket, fields: TapdStoryFields) {
  if (fields.tapdStatus) ticket.devStatus = fields.tapdStatus;
  if (fields.estimatedHours !== null) ticket.estimatedHours = fields.estimatedHours;
  if (fields.actualHours !== null) ticket.actualHours = fields.actualHours;
  if (fields.developer.length) ticket.developer = fields.developer;
  if (fields.currentHandler) ticket.currentHandler = fields.currentHandler;

  const newStage = resolveStage(ticket.status, ticket.devStatus, ticket.iterations);
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
  }
}

// 同一条工单不允许被批量任务和"点击TAPD地址"单条同步同时处理，避免两边并发写同一个 ticket 对象
const ticketsSyncingTapd = new Set<string>();

// 点击工单列表 TAPD 列地址时触发：只同步这一条工单，不占用批量任务的进度弹窗/store.currentJob。
// 无独立并发锁保护批量任务本身（批量任务见 startTapdJob），但会跟批量任务共享同一份"正在同步"标记，
// 防止同一条工单被两边同时处理
export async function syncSingleTicketTapd(ticket: Ticket, actor: string): Promise<void> {
  if (!ticket.tapdUrl) {
    throw new Error("该工单未关联TAPD地址");
  }
  if (ticketsSyncingTapd.has(ticket.id)) {
    throw new Error("该工单正在同步TAPD信息，请稍后再试");
  }
  ticketsSyncingTapd.add(ticket.id);
  const time = () => dayjs().format("YYYY-MM-DD HH:mm:ss");
  try {
    const fields = await fetchTapdFields(ticket.tapdUrl);
    applyTapdFields(ticket, fields);
    ticket.tapdErrorNote = null;
    store.addLog({
      type: "同步TAPD",
      time: time(),
      actor,
      success: true,
      failReason: null,
      detail: `单条同步TAPD：工单 ${ticket.code}`,
    });
  } catch (e) {
    const reason = (e as Error).message ?? "TAPD 同步失败";
    ticket.tapdErrorNote = { time: time(), message: reason };
    store.addLog({
      type: "同步TAPD",
      time: time(),
      actor,
      success: false,
      failReason: reason,
      detail: `单条同步TAPD失败：工单 ${ticket.code}`,
    });
    throw e;
  } finally {
    ticketsSyncingTapd.delete(ticket.id);
  }
}

router.post("/tapd/:id", async (req, res) => {
  const ticket = store.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ message: "工单不存在" });
  const { actor } = req.body as { actor?: string };
  try {
    await syncSingleTicketTapd(ticket, actor ?? "未知");
    res.json({ data: ticket });
  } catch (e) {
    res.status(500).json({ message: (e as Error).message ?? "同步TAPD信息失败" });
  }
});

// 获取TAPD信息：供路由与定时任务共用；不传 filters 时默认仅覆盖未完成未关闭且有TAPD地址的数据。
// 按条更新（每条各自调一次 TAPD 开放平台 API），单条失败只影响该条，不中断整个任务
export function startTapdJob(actor: string, filters?: unknown): { job: SyncJob; done: Promise<SyncJob> } {
  const candidates = resolveCandidates(filters).filter((t) => t.tapdUrl);
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

  const done = new Promise<SyncJob>((resolve) => {
    jobDoneResolver = resolve;
  });

  let idx = 0;
  stopJobTimer();
  jobTimer = setInterval(async () => {
    if (job.status !== "running") {
      finishJob(job);
      return;
    }
    const batch = candidates.slice(idx, idx + 5);
    idx += 5;
    for (const ticket of batch) {
      // 这条工单正被"点击TAPD地址"单条同步占用，本轮批量跳过，避免并发写同一个 ticket 对象
      if (ticketsSyncingTapd.has(ticket.id)) {
        job.failed += 1;
        job.failReasons.push(`${ticket.code}: 该工单正在被单条同步占用，本次批量跳过`);
        job.processed += 1;
        continue;
      }
      ticketsSyncingTapd.add(ticket.id);
      try {
        const fields = await fetchTapdFields(ticket.tapdUrl!);
        applyTapdFields(ticket, fields);
        ticket.tapdErrorNote = null; // 本次同步成功，清除历史异常标记
        job.success += 1;
      } catch (e) {
        const reason = (e as Error).message ?? "TAPD 同步失败";
        job.failed += 1;
        job.failReasons.push(`${ticket.code}: ${reason}`);
        // 按条更新：更新失败记录到 TAPD 异常备注字段，保留时间与原因
        ticket.tapdErrorNote = { time: dayjs().format("YYYY-MM-DD HH:mm:ss"), message: reason };
      } finally {
        ticketsSyncingTapd.delete(ticket.id);
      }
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
      finishJob(job);
    }
  }, 400);

  return { job, done };
}

router.post("/tapd", (req, res) => {
  const { actor, filters } = req.body as { actor: string; filters?: unknown };
  const { job } = startTapdJob(actor, filters);
  res.json({ job });
});

export default router;
