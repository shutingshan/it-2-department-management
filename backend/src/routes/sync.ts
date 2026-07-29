import { Router } from "express";
import dayjs from "dayjs";
import { store } from "../store";
import { dedupe, resolveStage } from "../mapping";
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

// 更新工单：供路由与定时任务共用。done 在任务完成（含被终止）时 resolve，便于定时任务链式等待。
//
// 当曲云没有"按编号查询单条"的接口/页面，只能把候选工单所在的当曲云工单列表整份抓一遍
// （复用获取新工单同一套抓取逻辑），再按编号匹配出这次要更新的候选工单、应用最新字段
// （复用 mapScrapedRowToTicket，跟获取新工单全量模式覆盖已有工单走的是同一套映射口径，
// 包括"实际梳理完成"这类只在当曲云列表里、不需要进详情页才能拿到的字段）。
// 未在当曲云列表里匹配到编号的候选工单、或整份列表都抓取失败，记为失败并反填 dangquyunErrorNote，
// 不影响其余候选工单
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

  stopJobTimer();

  (async () => {
    const rowsByCode = new Map<string, ScrapedRow>();
    let scrapeError: string | null = null;
    try {
      const result = await scrapeDangquyunTicketList();
      for (const row of result.rows) {
        const code = row["编号"]?.trim();
        if (code) rowsByCode.set(code, row);
      }
    } catch (e) {
      scrapeError = (e as Error).message ?? "当曲云抓取失败";
    }

    for (const ticket of candidates) {
      if (job.status !== "running") break; // 被 /terminate 手动终止

      const failReason = scrapeError ?? (rowsByCode.has(ticket.code) ? null : "当曲云工单列表中未找到该编号");
      if (failReason) {
        job.failed += 1;
        job.failReasons.push(`${ticket.code}: ${failReason}`);
        ticket.dangquyunErrorNote = { time: dayjs().format("YYYY-MM-DD HH:mm:ss"), message: failReason };
        job.processed += 1;
        continue;
      }

      try {
        const row = rowsByCode.get(ticket.code)!;
        const title = row["标题"]?.trim();
        if (!title) throw new Error("标题字段获取失败");
        const oldStage = ticket.stage;
        Object.assign(ticket, mapScrapedRowToTicket(row, ticket));
        ticket.dangquyunErrorNote = null;
        if (ticket.stage !== oldStage) {
          store.addChangeLog(ticket, [
            {
              field: "stage",
              oldValue: oldStage,
              newValue: ticket.stage,
              time: dayjs().format("YYYY-MM-DD HH:mm:ss"),
              actor: "系统同步",
            },
          ]);
        }
        job.success += 1;
      } catch (e) {
        const reason = (e as Error).message ?? "数据解析失败";
        job.failed += 1;
        job.failReasons.push(`${ticket.code}: ${reason}`);
        ticket.dangquyunErrorNote = { time: dayjs().format("YYYY-MM-DD HH:mm:ss"), message: reason };
      }
      job.processed += 1;
    }

    if (job.status === "running") {
      job.status = "done";
      job.finishedAt = dayjs().format("YYYY-MM-DD HH:mm:ss");
      store.lastUpdateTime = job.finishedAt;
      store.addLog({
        type: "更新工单",
        time: job.finishedAt,
        actor,
        success: job.failed === 0,
        failReason: job.failed ? job.failReasons.join("; ") : null,
        detail: scrapeError
          ? `批量更新失败：获取当曲云工单列表出错（${scrapeError}）`
          : `批量更新完成，成功 ${job.success} 条，失败 ${job.failed} 条`,
      });
    }
    finishJob(job);
  })();

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
// 避免两处各写一套导致字段口径不一致。各字段"取不到就保持工单原值不动"，不会用空值覆盖
function applyTapdFields(ticket: Ticket, fields: TapdStoryFields) {
  // TAPD 上确认没填的字段：工单里也要跟着清空，保证两边一致（界面上即显示为"-"）。
  // 只有"抓取失败没读到"的字段才保持工单原值不动
  const isEmptyOnTapd = (name: string) => fields.emptyFields.includes(name);

  if (fields.tapdStatus) ticket.devStatus = fields.tapdStatus;
  else if (isEmptyOnTapd("TAPD状态")) ticket.devStatus = null;

  if (fields.estimatedHours !== null) ticket.estimatedHours = fields.estimatedHours;
  else if (isEmptyOnTapd("预估工时")) ticket.estimatedHours = 0;

  if (fields.actualHours !== null) ticket.actualHours = fields.actualHours;
  else if (isEmptyOnTapd("完成工时")) ticket.actualHours = 0;

  if (fields.developer.length) ticket.developer = fields.developer;
  else if (isEmptyOnTapd("开发人员")) ticket.developer = [];

  if (fields.currentHandler) ticket.currentHandler = fields.currentHandler;
  else if (isEmptyOnTapd("处理人")) ticket.currentHandler = "";

  // 迭代：TAPD 当前迭代是什么就是什么，直接替换成最新值（不再跟旧值合并保留历史）；
  // TAPD 上确认没有迭代时清空（会连带让工单阶段回落到"待排期"，这是预期行为）
  if (fields.iterationName) {
    ticket.iterations = [
      { name: fields.iterationName, start: fields.iterationStart ?? "", end: fields.iterationEnd ?? "" },
    ];
  } else if (isEmptyOnTapd("迭代")) {
    ticket.iterations = [];
  }

  // 月度计划：同样直接替换成 TAPD 最新值，不再跟旧值合并
  if (fields.monthlyPlan.length) {
    ticket.monthlyPlan = dedupe(fields.monthlyPlan);
  } else if (isEmptyOnTapd("月度计划")) {
    ticket.monthlyPlan = [];
  }

  // 子需求：null 表示本次没能获取（保持原值），空数组表示确认没有子需求
  if (fields.subStories !== null) {
    ticket.subTickets = fields.subStories.map((s) => ({
      id: s.storyId,
      code: s.storyId,
      tapdUrl: s.tapdUrl,
      title: s.title,
      productManager: s.productManager ?? "",
      developer: s.developer.join("、"),
      tester: s.tester.join("、"),
      currentHandler: s.currentHandler ?? "",
      tapdStatus: s.tapdStatus,
      monthlyPlan: [],
      iteration: s.iterationName ? { name: s.iterationName, start: "", end: "" } : null,
      estimatedHours: s.estimatedHours ?? 0,
      actualHours: s.actualHours ?? 0,
    }));

    // 有子需求时，父需求的开发人员/当前处理人/迭代/实际工时改由子需求汇总得出，
    // 不再采信父需求自己 TAPD 页面上的这几个字段——这是最早原型阶段模拟数据生成规则
    // 就定好的口径（backend/src/seed.ts 的 hasSubTickets 分支），这次把它接到真实同步逻辑上。
    // 月度计划、预估工时不在这份汇总里：子需求目前没有月度计划的真实取数来源（TAPD子需求页签
    // 表格里没有这一列），预估工时沿用原型口径（子需求预估工时不汇总进父需求）
    if (fields.subStories.length > 0) {
      ticket.developer = dedupe(fields.subStories.flatMap((s) => s.developer));
      ticket.currentHandler = fields.subStories
        .map((s) => s.currentHandler)
        .filter((h): h is string => !!h)
        .join("、");
      ticket.iterations = fields.subStories
        .filter((s) => s.iterationName)
        .map((s) => ({ name: s.iterationName as string, start: "", end: "" }));
      ticket.actualHours = Number(
        fields.subStories.reduce((sum, s) => sum + (s.actualHours ?? 0), 0).toFixed(1)
      );
    }
  }

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
export async function syncSingleTicketTapd(ticket: Ticket, actor: string): Promise<TapdStoryFields> {
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
    return fields;
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
    const fields = await syncSingleTicketTapd(ticket, actor ?? "未知");
    // 只报告"真正没抓到"的字段：TAPD 上本来就没填（emptyFields）的不算异常，
    // 那种情况工单里已经跟着清空了，两边是一致的
    const missingFields: string[] = [];
    const check = (name: string, got: boolean) => {
      if (!got && !fields.emptyFields.includes(name)) missingFields.push(name);
    };
    check("TAPD状态", !!fields.tapdStatus);
    check("预估工时", fields.estimatedHours !== null);
    check("完成工时", fields.actualHours !== null);
    check("开发人员", fields.developer.length > 0);
    check("测试人员", fields.tester.length > 0);
    check("处理人", !!fields.currentHandler);
    check("迭代", !!fields.iterationName);
    check("月度计划", fields.monthlyPlan.length > 0);
    if (fields.subStories === null) missingFields.push("子需求列表");
    res.json({ data: ticket, missingFields });
  } catch (e) {
    res.status(500).json({ message: (e as Error).message ?? "同步TAPD信息失败" });
  }
});

// 获取TAPD信息：供路由与定时任务共用；不传 filters 时默认仅覆盖未完成未关闭且有TAPD地址的数据。
// 严格排队逐条执行：等上一条完全结束（无论成功失败）才开始下一条，不能并发展开——
// 浏览器模式下每条都要起一个独立的 Chromium 实例访问 TAPD，一次性铺开会像当曲云那次一样
// 多个浏览器实例抢同一份登录态文件互相干扰，也更容易被 TAPD 的安全网关当成批量自动化行为拦截。
// 之前用 setInterval(async () => {...}, 400) 驱动，但 setInterval 不会等 async 回调跑完
// 就继续按固定间隔触发下一次——只要单条耗时超过 400ms（几乎总是），后面的 tick 会在前一批
// 还没跑完时就再取一批新的候选工单开始处理，导致实际上是大量工单同时在跑，
// 因此改成真正的顺序循环，不再用定时器驱动
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

  stopJobTimer(); // 清掉可能还挂着的上一个任务的定时器（如"更新工单"仍在用 setInterval 驱动）

  (async () => {
    for (const ticket of candidates) {
      // 任务被 /terminate 手动终止：不再处理剩余工单，日志已由 /terminate 那边记过
      if (job.status !== "running") break;

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

    if (job.status === "running") {
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
    }
    finishJob(job);
  })();

  return { job, done };
}

router.post("/tapd", (req, res) => {
  const { actor, filters } = req.body as { actor: string; filters?: unknown };
  const { job } = startTapdJob(actor, filters);
  res.json({ job });
});

export default router;
