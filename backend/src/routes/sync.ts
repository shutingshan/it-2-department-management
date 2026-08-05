import { Router } from "express";
import dayjs from "dayjs";
import type { Browser, Page } from "playwright";
import { store } from "../store";
import { dedupe, resolveStage } from "../mapping";
import { SyncJob } from "../store";
import { ScrapedRow, scrapeDangquyunTicketList } from "../scrapers/dangquyunScraper";
import { mapScrapedRowToTicket } from "../scrapers/dangquyunMapper";
import { fetchTapdStoryFields, TapdStoryFields } from "../scrapers/tapdApi";
import { scrapeTapdStoryFields, scrapeTapdStoryFieldsViaBrowser } from "../scrapers/tapdScraper";
import {
  cancelInteractiveLogin,
  confirmInteractiveLogin,
  getInteractiveLoginStatus,
  getTapdAuthenticatedContext,
  hasSavedLoginState,
  launchTapdBrowser,
  startInteractiveLogin,
  TapdLoginRequiredError,
} from "../scrapers/tapdAuth";
import { config } from "../config";
import { applyFilters, parseQuery, scopeForActor, TicketQuery } from "../filter";
import { SyncPermission, Ticket } from "../types";

// 权限不足跟"抓取失败"是两码事：前者该返回 403 让前端明确提示去找管理员开权限，
// 后者才是 500。用独立错误类型区分，不靠匹配错误文案
class SyncPermissionError extends Error {}

// 同步类操作按账号授权（管理员始终全部可用）。前端会隐藏没授权的菜单项，
// 但那只是体验，真正的拦截必须在这里做——否则直接调接口就绕过去了
function assertSyncPermission(actor: string | undefined, key: SyncPermission): void {
  const account = store.accounts.find((a) => a.name === actor);
  if (!account) throw new SyncPermissionError("当前账号未授权，请联系管理员进行授权");
  if (account.role === "admin") return;
  if (!(account.syncPermissions ?? []).includes(key)) {
    throw new SyncPermissionError("没有该操作的权限，请联系管理员在账号配置中勾选");
  }
}

// TAPD 取数入口：按 .env 里 TAPD_FETCH_MODE 在 开放平台API / 浏览器页面爬取 两种方式间切换，
// 两种方式返回同一套字段结构，后续的字段应用/阶段重算逻辑完全一致
function fetchTapdFields(tapdUrl: string): Promise<TapdStoryFields> {
  return config.tapd.fetchMode === "browser"
    ? scrapeTapdStoryFieldsViaBrowser(tapdUrl)
    : fetchTapdStoryFields(tapdUrl);
}

// 圈定候选工单，口径必须跟操作人在工单中心列表里看到的完全一致，依次收敛：
//   1. 分类显示范围配置（store.visibleTickets）
//   2. 登录身份可见范围（IT受理人只看自己负责的、需求方只看跟自己相关的）
//   3. 列表当前的筛选条件；未传筛选条件时表示"列表没筛"，用前两步的结果
// 最后无论有没有筛选，都只处理"未完成未关闭"的工单，不逐条处理已完成/已关闭的
function resolveCandidates(filters: unknown, actor?: string): Ticket[] {
  const role = store.accounts.find((a) => a.name === actor)?.role;
  const visible = scopeForActor(store.visibleTickets, actor, role);
  const hasFilters = filters && typeof filters === "object" && Object.keys(filters as object).length > 0;
  const base = hasFilters
    ? applyFilters(visible, parseQuery(filters as Record<string, unknown>) as TicketQuery)
    : visible;
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

// 最保险的一道抓取校验：地址、页面结构都对，不代表抓到的一定是预期的那份工单列表
// （比如筛选条件被重置、翻页逻辑抓到了别的视图）。挑一条工单中心这边已经是"已完成"状态的
// 工单，检查这次抓到的当曲云列表里是否还找得到这个编号——连一条已完成的工单都对不上，
// 说明这次数据来源可疑，宁可这次不抓，也不能拿一份可疑数据去新增/覆盖工单。
// 挑"已完成"里最近完成的一条做验证：当曲云列表本身可能有时间范围之类的默认筛选，
// 太久以前完成的工单不一定还留在列表里，用最近完成的能尽量避免"验证工单本来就没在列表里"
// 这种误判；工单中心里还没有任何"已完成"的工单时没法做这个校验，直接跳过
function verifyScrapedRowsAgainstCompletedTicket(rows: ScrapedRow[]) {
  const completed = store.tickets.filter((t) => t.stage === "已完成");
  if (completed.length === 0) return;

  const verificationTicket = [...completed].sort((a, b) =>
    (b.actualCompleteTime ?? b.submittedAt).localeCompare(a.actualCompleteTime ?? a.submittedAt)
  )[0];

  const scrapedCodes = new Set(rows.map((r) => r["编号"]?.trim()).filter(Boolean));
  if (!scrapedCodes.has(verificationTicket.code)) {
    throw new Error(`当前工单列表与要求列表不符。工单验证编号：${verificationTicket.code}`);
  }
}

// 按「受理人范围」配置收敛本次要落库的行：配置为空表示不限制（保持升级前的行为）。
// 受理人是多人字段（当曲云里用顿号/分号等拼接），命中其中任意一人即算在范围内
export function applyHandlerScope(rows: ScrapedRow[]): ScrapedRow[] {
  const allowed = store.fetchScopeHandlers.map((i) => i.value);
  if (!allowed.length) return rows;
  return rows.filter((row) => {
    const raw = row["受理人"]?.trim();
    if (!raw) return false;
    return raw
      .split(/[、,，;；\/]/)
      .map((v) => v.trim())
      .filter(Boolean)
      .some((name) => allowed.includes(name));
  });
}

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
    if (result.strategy === "none") {
      // 地址对了，但三种表格结构都没识别出来（页面改版/选择器失效等）：不能当成"0条新工单"，
      // 否则会跟"这次确实没有新工单"混为一谈，误导使用者以为抓取正常
      throw new Error(
        "未能识别当曲云工单列表页面结构，本次抓取判定无效（截图/HTML已保存到 backend/.auth/debug/）"
      );
    }
    // 核验必须在按受理人过滤之前做：用于核验的那条已完成工单不一定属于配置里的受理人，
    // 先过滤会把它滤掉，导致核验必然失败
    verifyScrapedRowsAgainstCompletedTicket(result.rows);
    const scopedRows = applyHandlerScope(result.rows);
    const { addedCount, updatedCount, failedCount, failReasons } = applyScrapedRows(scopedRows, isFull);

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
      detail: `本次抓取 ${result.pageCount} 页共 ${result.rows.length} 条（策略：${result.strategy}）${
        result.rows.length !== scopedRows.length ? `，按受理人范围保留 ${scopedRows.length} 条` : ""
      }，新增 ${addedCount} 条${
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
    assertSyncPermission(actor, mode === "full" ? "fetch-full" : "fetch-incremental");
    const result = await runFetchNew(actor, mode);
    res.json({ ...result, job: store.currentJob });
  } catch (e) {
    if (e instanceof SyncPermissionError) {
      return res.status(403).json({ message: e.message });
    }
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
  const candidates = resolveCandidates(filters, actor);
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
      if (result.strategy === "none") {
        // 同 runFetchNew：地址对但结构没识别出来，不能当成"当曲云列表里没这些编号"处理
        throw new Error("未能识别当曲云工单列表页面结构，本次批量更新判定无效");
      }
      verifyScrapedRowsAgainstCompletedTicket(result.rows);
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
  try {
    assertSyncPermission((req.body as { actor?: string }).actor, "update");
  } catch (e) {
    return res.status(403).json({ message: (e as Error).message });
  }
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
export function applyTapdFields(ticket: Ticket, fields: TapdStoryFields) {
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
      ticket.currentHandler = dedupe(
        fields.subStories.map((s) => s.currentHandler).filter((h): h is string => !!h)
      ).join("、");
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

// 浏览器模式下同步前先做一次"本地有没有登录态文件"的快速预检：没有就直接告诉前端需要登录
// （needLogin=true），由前端弹窗引导扫码、登录完再自动重试，不用白开一趟浏览器。
// 注意这只能查出"从没登录过"；"登录过但已过期"要真正访问一次TAPD才知道，那种情况由
// startTapdJob / syncSingleTicketTapd 里的 TapdLoginRequiredError 兜住
function needTapdLogin(): boolean {
  return config.tapd.fetchMode === "browser" && !hasSavedLoginState();
}

const TAPD_LOGIN_HINT = "TAPD 尚未登录，请先完成扫码登录后再获取TAPD信息";

// TAPD 扫码登录：把原来只能在终端完成的"扫完码后按回车确认"搬到页面上。
// start 负责弹出浏览器窗口并停在TAPD首页，用户在窗口里扫码登录完成后，再调 confirm 保存登录态。
// 浏览器是在跑后端的这台机器上弹出来的，所以同样只适用于后端跑在有图形界面的机器上
router.get("/tapd-login/status", (_req, res) => {
  res.json({ data: getInteractiveLoginStatus() });
});

router.post("/tapd-login/start", async (req, res) => {
  try {
    assertSyncPermission((req.body as { actor?: string }).actor, "tapd-login");
    await startInteractiveLogin();
    res.json({ data: getInteractiveLoginStatus() });
  } catch (e) {
    if (e instanceof SyncPermissionError) {
      return res.status(403).json({ message: e.message });
    }
    res.status(500).json({ message: (e as Error).message ?? "打开TAPD登录窗口失败" });
  }
});

router.post("/tapd-login/confirm", async (req, res) => {
  const { actor } = req.body as { actor?: string };
  try {
    await confirmInteractiveLogin();
    store.addLog({
      type: "同步TAPD",
      time: dayjs().format("YYYY-MM-DD HH:mm:ss"),
      actor: actor ?? "未知",
      success: true,
      failReason: null,
      detail: "TAPD扫码登录完成，登录态已保存",
    });
    res.json({ data: getInteractiveLoginStatus() });
  } catch (e) {
    res.status(500).json({ message: (e as Error).message ?? "保存TAPD登录态失败" });
  }
});

router.post("/tapd-login/cancel", async (_req, res) => {
  await cancelInteractiveLogin();
  res.json({ data: getInteractiveLoginStatus() });
});

router.post("/tapd/:id", async (req, res) => {
  const ticket = store.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ message: "工单不存在" });
  const { actor } = req.body as { actor?: string };
  try {
    assertSyncPermission(actor, "tapd");
  } catch (e) {
    return res.status(403).json({ message: (e as Error).message });
  }
  if (needTapdLogin()) {
    return res.status(409).json({ needLogin: true, message: TAPD_LOGIN_HINT });
  }
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
    // 登录态过期（预检查不出来，真正访问TAPD时才发现）：同样告诉前端需要登录，让它引导扫码后重试
    if (e instanceof TapdLoginRequiredError) {
      return res.status(409).json({ needLogin: true, message: e.message });
    }
    res.status(500).json({ message: (e as Error).message ?? "同步TAPD信息失败" });
  }
});

// 浏览器模式下批量任务复用的浏览器/已登录页面：整个批量任务共用同一个 Chromium 实例，
// 逐条工单在同一个页面上"导航到该工单详情页 -> 抓字段"，而不是每条工单都重新起一次浏览器、
// 重新做一遍登录态校验——量大的时候（上百条工单）光是反复启/停浏览器的开销就能占掉大半时间。
// 仍然保持严格顺序执行，同一时刻只有一个浏览器窗口在跑，跟之前的反风控顾虑没有冲突，
// 只是省掉"每条都重开一次浏览器"这一层固定开销
// 需要重新扫码登录时直接向上抛（由调用方整单终止任务并提示去登录），其余失败退回逐条独立开浏览器
async function launchSharedTapdSession(): Promise<{ browser: Browser; page: Page } | null> {
  let browser: Browser | null = null;
  try {
    browser = await launchTapdBrowser();
    const { page } = await getTapdAuthenticatedContext(browser);
    return { browser, page };
  } catch (e) {
    await browser?.close().catch(() => {});
    if (e instanceof TapdLoginRequiredError) throw e;
    console.warn("[tapd] 批量任务复用浏览器初始化失败，本次退回逐条独立开浏览器：", (e as Error).message);
    return null;
  }
}

// 获取TAPD信息：供路由与定时任务共用；不传 filters 时默认仅覆盖未完成未关闭且有TAPD地址的数据。
// 严格排队逐条执行：等上一条完全结束（无论成功失败）才开始下一条，不能并发展开——
// 浏览器模式下一次性铺开多个浏览器实例会像当曲云那次一样互相抢同一份登录态文件干扰，
// 也更容易被 TAPD 的安全网关当成批量自动化行为拦截。
// 之前用 setInterval(async () => {...}, 400) 驱动，但 setInterval 不会等 async 回调跑完
// 就继续按固定间隔触发下一次——只要单条耗时超过 400ms（几乎总是），后面的 tick 会在前一批
// 还没跑完时就再取一批新的候选工单开始处理，导致实际上是大量工单同时在跑，
// 因此改成真正的顺序循环，不再用定时器驱动
export function startTapdJob(actor: string, filters?: unknown): { job: SyncJob; done: Promise<SyncJob> } {
  const candidates = resolveCandidates(filters, actor).filter((t) => t.tapdUrl);
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
    let session: { browser: Browser; page: Page } | null = null;
    if (config.tapd.fetchMode === "browser" && candidates.length > 0) {
      try {
        session = await launchSharedTapdSession();
      } catch (e) {
        // 登录态无效/已过期：整单终止，不逐条去撞同一个错误——否则每条工单都会失败一次，
        // 失败原因刷满一屏，还白白开关一堆浏览器窗口
        const reason = (e as Error).message ?? "TAPD 尚未登录";
        job.status = "failed";
        job.finishedAt = dayjs().format("YYYY-MM-DD HH:mm:ss");
        job.failReasons.push(reason);
        store.addLog({
          type: "同步TAPD",
          time: job.finishedAt,
          actor,
          success: false,
          failReason: reason,
          detail: "同步 TAPD 终止：需要重新扫码登录",
        });
        finishJob(job);
        return;
      }
    }

    try {
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
          const fields =
            session && !session.page.isClosed()
              ? await scrapeTapdStoryFields(session.page, ticket.tapdUrl!)
              : await fetchTapdFields(ticket.tapdUrl!);
          applyTapdFields(ticket, fields);
          ticket.tapdErrorNote = null; // 本次同步成功，清除历史异常标记
          job.success += 1;
        } catch (e) {
          const reason = (e as Error).message ?? "TAPD 同步失败";
          job.failed += 1;
          job.failReasons.push(`${ticket.code}: ${reason}`);
          // 按条更新：更新失败记录到 TAPD 异常备注字段，保留时间与原因
          ticket.tapdErrorNote = { time: dayjs().format("YYYY-MM-DD HH:mm:ss"), message: reason };
          // 复用的页面可能因为这次失败而报废（比如窗口被意外关闭），检测到就丢弃重开一个，
          // 避免这条工单的问题连累后面所有工单都跟着失败
          if (session && session.page.isClosed()) {
            await session.browser.close().catch(() => {});
            session = await launchSharedTapdSession();
          }
        } finally {
          ticketsSyncingTapd.delete(ticket.id);
        }
        job.processed += 1;
      }
    } finally {
      await session?.browser.close().catch(() => {});
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
  try {
    assertSyncPermission(actor, "tapd");
  } catch (e) {
    return res.status(403).json({ message: (e as Error).message });
  }
  if (needTapdLogin()) {
    return res.status(409).json({ needLogin: true, message: TAPD_LOGIN_HINT });
  }
  const { job } = startTapdJob(actor, filters);
  res.json({ job });
});

export default router;
