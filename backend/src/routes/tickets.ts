import { Router } from "express";
import dayjs from "dayjs";
import { backupStoreFile, store } from "../store";
import {
  applyFilters,
  canViewTicket,
  parseQuery,
  scopeForActor,
  scopeForDefectActor,
  TicketQuery,
} from "../filter";
import { canAccessDefects } from "../permissions";
import { MONTH_RE, resolveExpectedMonthOptions } from "../expectedMonth";
import { dedupe, stripCurrentIterationTag } from "../mapping";
import { computeCardStats } from "../cards";
import { ChangeLogEntry } from "../types";

const router = Router();


// 工单中心统计卡片数据，需在 "/:id" 之前注册，避免被当成 id 参数捕获。
// 支持按 itHandler 圈定范围（"切换人员"选中目标后，卡片数量也要跟着只统计这些人的工单，
// 不传时统计全部工单）——只认 itHandler 这一个维度，不跟列表当前的其余筛选条件联动，
// 跟"我负责的工单"/"切换人员"的既有语义保持一致
router.get("/card-stats", (req, res) => {
  const { itHandler } = parseQuery(req.query as Record<string, unknown>);
  const { actor, actorRole } = req.query as { actor?: string; actorRole?: string };
  // 先按登录身份圈定可见范围（IT受理人只看自己负责的、需求方只看跟自己相关的），
  // 再叠加"切换人员"选中的目标——否则卡片数量会大于该身份实际能在列表里看到的工单数
  // 分类显示范围要和列表用同一个口径，否则卡片数量会大于列表里实际能看到的条数
  const visible = store.visibleTickets;
  const scoped = scopeForActor(visible, actor, actorRole);
  const tickets = itHandler?.length ? scoped.filter((t) => itHandler.includes(t.itHandler)) : scoped;
  res.json({ data: computeCardStats(tickets) });
});

// 真实工单数据里出现过的 IT 受理人（去重排序），供"切换人员"等入口使用。
// 不用人员目录（store.users）是因为那份是预置的部门人员名单，跟真实工单里实际出现的
// 受理人不一定对得上：目录里有的人可能一条工单都没有，工单里的人也可能不在目录里。
// 同样走分类显示范围：否则下拉里会出现"选了之后列表一条都没有"的人
router.get("/it-handlers", (_req, res) => {
  const names = dedupe(store.visibleTickets.map((t) => t.itHandler))
    .filter((v) => v && v.trim())
    .sort();
  const data = names.map((name) => {
    const matched = store.users.find((u) => u.name === name);
    return { id: matched?.id ?? name, name, avatarColor: matched?.avatarColor ?? "#999999" };
  });
  res.json({ data });
});

// 工单编号候选（仅关联了TAPD地址的），供"获取TAPD信息"弹窗里按单条工单编号选择使用。
// 同样走分类显示范围：否则能选到工单中心里根本看不到的工单去同步
router.get("/codes", (_req, res) => {
  const codes = dedupe(store.visibleTickets.filter((t) => t.tapdUrl).map((t) => t.code)).sort();
  res.json({ data: codes });
});

router.get("/", (req, res) => {
  const q = parseQuery(req.query as Record<string, unknown>);
  const { actor, actorRole, scope } = req.query as { actor?: string; actorRole?: string; scope?: string };
  // scope=defect：缺陷跟进页，分类范围走 defectCategories 而不是工单中心那份，
  // 可见范围换成缺陷那套：按账号授权准入，通过则看全部（见 permissions.canAccessDefects）
  const isDefect = scope === "defect";
  const base = isDefect ? store.defectVisibleTickets : store.visibleTickets;
  const scoped = isDefect
    ? scopeForDefectActor(base, canAccessDefects(actor))
    : scopeForActor(base, actor, actorRole);
  const filtered = applyFilters(scoped, q);

  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.pageSize ?? 20);
  const start = (page - 1) * pageSize;
  const pageData = filtered.slice(start, start + pageSize);

  // 下拉候选值以当前筛选结果为边界，不越界到全量数据；但每个下拉自己的那一项要排除掉，
  // 否则多选没法用：比如选了月度计划「2026-06」后，结果里只剩带该月份的工单，
  // 候选值跟着收缩成只有「2026-06」，想再加选一个月份根本点不到。
  // 每个下拉按「除它自己以外的其余筛选条件」算候选，是多条件筛选的通行做法
  const facetSource = (omit: keyof TicketQuery) => applyFilters(scoped, { ...q, [omit]: undefined });
  const facets = {
    requesters: dedupe(facetSource("requester").map((t) => t.requester)).sort(),
    watchers: dedupe(facetSource("watcher").flatMap((t) => t.watcher)).sort(),
    itHandlers: dedupe(facetSource("itHandler").map((t) => t.itHandler)).sort(),
    // 开发人员没有对应的筛选项，直接用当前结果即可
    developers: dedupe(filtered.flatMap((t) => t.developer)).sort(),
    monthlyPlans: dedupe(facetSource("monthlyPlan").flatMap((t) => t.monthlyPlan)).sort(),
    iterations: dedupe(
      facetSource("iteration").flatMap((t) => t.iterations.map((i) => stripCurrentIterationTag(i.name)))
    ).sort(),
    owningApps: dedupe(facetSource("owningApp").map((t) => t.owningApp)).sort(),
    // 期望月度的候选值不走 facetSource：它不是"当前数据里出现过什么"，而是管理员配置的
    // 一份可选清单（见 expectedMonth.ts），需方要能填系统里还没排到的月份
    expectedMonths: resolveExpectedMonthOptions(store.tickets, store.expectedMonthSource),
    categories: dedupe(facetSource("category").map((t) => t.category)).sort(),
  };

  res.json({ data: pageData, total: filtered.length, facets, lastUpdateTime: store.lastUpdateTime });
});

router.get("/:id", (req, res) => {
  const ticket = store.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ message: "工单不存在" });
  const { actor, actorRole } = req.query as { actor?: string; actorRole?: string };
  if (!canViewTicket(ticket, actor, actorRole)) {
    return res.status(403).json({ message: "无权限查看该工单" });
  }
  res.json({ data: ticket });
});

// 紧急、备注两个字段所有角色均可实时编辑；缺陷跟进的几个字段同理，均为人工维护、不受同步影响
const EDITABLE_FIELDS = [
  "urgent",
  "remark",
  "monthlyPlan",
  "expectedMonth",
  "hasTestCase",
  "testCaseSupplemented",
  "hasAutomatedTest",
  "automationPlanCompleteTime",
  "completionStatus",
  "spentHours",
] as const;
// 仅管理员可编辑的字段。月度计划是从 TAPD 同步过来的字段，放开给管理员是为了
// 在 TAPD 还没维护好时能先手工补上；它仍会被下一次「获取TAPD信息」按 TAPD 的值覆盖
const ADMIN_ONLY_FIELDS: string[] = ["monthlyPlan"];
// 数组字段：接受数组或「、,，」分隔的字符串，统一清洗成去重后的字符串数组
const ARRAY_FIELDS: string[] = ["monthlyPlan"];

function normalizeFieldValue(key: string, raw: unknown): unknown {
  // 期望月度清空时前端传的是空串（Select allowClear），统一归一成 null，
  // 免得落盘里同时存在 null 和 "" 两种"没填"
  if (key === "expectedMonth") {
    const v = typeof raw === "string" ? raw.trim() : raw;
    return v === "" || v === undefined ? null : v;
  }
  if (!ARRAY_FIELDS.includes(key)) return raw;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[、,，]/) : [];
  return dedupe(list.map((v) => String(v).trim()).filter(Boolean));
}

// 缺陷跟进那几个字段的取值校验。不校验的话前端传什么就存什么，
// 比如 spentHours 传成 "abc" 会原样落库，之后既落不进工时区间筛选、
// 又会以文本形式写进导出表格的数字列
const TRI_STATE_FIELDS = ["hasTestCase", "testCaseSupplemented", "hasAutomatedTest"];
const COMPLETION_VALUES = ["", "未开始", "进行中", "已完成"];

/** 校验通过返回 null，否则返回给前端的错误文案 */
function validateFieldValue(key: string, v: unknown): string | null {
  if (TRI_STATE_FIELDS.includes(key)) {
    return v === null || typeof v === "boolean" ? null : `${key} 只能是 true/false 或空`;
  }
  if (key === "completionStatus") {
    return typeof v === "string" && COMPLETION_VALUES.includes(v)
      ? null
      : `completionStatus 只能是 ${COMPLETION_VALUES.filter(Boolean).join("/")} 或空`;
  }
  if (key === "automationPlanCompleteTime") {
    if (v === null) return null;
    return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
      ? null
      : "automationPlanCompleteTime 只能是 YYYY-MM-DD 或空";
  }
  if (key === "expectedMonth") {
    if (v === null) return null;
    return typeof v === "string" && MONTH_RE.test(v) ? null : "需方期望月度只能是 YYYY-MM 或空";
  }
  if (key === "spentHours") {
    if (v === null) return null;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? null : "spentHours 只能是非负数字或空";
  }
  return null;
}

// 变更日志里数组按「、」展示，避免记成 "a,b" 这种不好读的形式；空数组记成 "-"；
// 缺陷跟进的"是否"类字段是布尔值，记成 true/false/null 不好读，转成中文。
// 注意：这只是"给人看"的文案，不能拿来判断值有没有变——见下面的 isSameValue
function displayValue(v: unknown): string {
  if (Array.isArray(v)) return v.join("、") || "-";
  if (v === null || v === undefined || v === "") return "-";
  if (v === true) return "是";
  if (v === false) return "否";
  return String(v);
}

/**
 * 判断字段值有没有变化。必须比较真实值而不是 displayValue 的结果：
 * displayValue 把空值渲染成 "-"，而 "-" 本身也可能是用户真的输入的内容，
 * 用文案比较的话，往空备注里填一个 "-"（或把内容为 "-" 的备注清空）
 * 会被判定成"没变化"而被静默丢弃，接口还返回 200
 */
function isSameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = Array.isArray(a) ? a : [];
    const bb = Array.isArray(b) ? b : [];
    return aa.length === bb.length && aa.every((v, i) => v === bb[i]);
  }
  // null 与 undefined 在这些字段上语义相同（都表示没填），其余一律严格比较
  const norm = (v: unknown) => (v === undefined ? null : v);
  return norm(a) === norm(b);
}

router.patch("/:id", (req, res) => {
  const ticket = store.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ message: "工单不存在" });

  const { fields, actor, actorRole, view } = req.body as {
    fields: Record<string, unknown>;
    actor: string;
    actorRole: string;
    view?: string;
  };
  if (!actor) return res.status(400).json({ message: "缺少操作人信息，无法提交" });

  if (view === "defect") {
    // 工单必须确实落在缺陷范围内——否则客户端只要带上 view=defect，
    // 就能绕过下面工单中心那套更严的编辑权限去改别的分类的工单
    const inDefectScope = store.defectVisibleTickets.some((t) => t.id === ticket.id);
    if (!inDefectScope) {
      return res.status(403).json({ message: "无权限：该工单不在缺陷跟进范围内" });
    }
    // 缺陷页「看得到就改得动」：可见范围是全有或全无，所以这里同样只判准入，
    // 通过的人可以改任意一条缺陷（含不是自己发起/受理的那些）
    if (!canAccessDefects(actor)) {
      return res.status(403).json({ message: "无权限：该账号未被授权访问缺陷跟进" });
    }
  } else {
    // IT 受理人仅可编辑自己负责的数据；需求方仅可编辑发起人或关注人包含本人的数据
    if (actorRole === "it_handler" && ticket.itHandler !== actor) {
      return res.status(403).json({ message: "无权限：仅能编辑本人负责的工单" });
    }
    if (actorRole === "requester" && !canViewTicket(ticket, actor, actorRole)) {
      return res.status(403).json({ message: "无权限：仅能编辑发起人或关注人包含本人的工单" });
    }
  }

  const changeEntries: ChangeLogEntry[] = [];
  for (const key of Object.keys(fields)) {
    if (!EDITABLE_FIELDS.includes(key as any)) {
      return res.status(400).json({ message: `字段校验失败：${key} 不可编辑` });
    }
    if (ADMIN_ONLY_FIELDS.includes(key) && actorRole !== "admin") {
      return res.status(403).json({ message: `无权限：${key} 仅管理员可编辑` });
    }
    const normalized = normalizeFieldValue(key, (fields as any)[key]);
    const invalid = validateFieldValue(key, normalized);
    if (invalid) {
      return res.status(400).json({ message: `字段校验失败：${invalid}` });
    }
    if (!isSameValue((ticket as any)[key], normalized)) {
      changeEntries.push({
        field: key,
        oldValue: displayValue((ticket as any)[key]),
        newValue: displayValue(normalized),
        time: dayjs().format("YYYY-MM-DD HH:mm:ss"),
        actor,
      });
      (ticket as any)[key] = normalized;
    }
  }

  // 值没有任何变化时直接返回，不写处理记录——否则前端一次误触（比如清空一个本来
  // 就是空的下拉）就会在工单里留下一条"更新字段：无变化"的噪声
  if (changeEntries.length === 0) {
    return res.json({ data: ticket });
  }

  store.addChangeLog(ticket, changeEntries);
  ticket.processingNotes.push({
    time: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    actor,
    content: `更新字段：${changeEntries.map((c) => c.field).join("、")}`,
  });

  // 需求方维护字段后，自动推送站内信给管理员角色
  if (actorRole === "requester" && changeEntries.length) {
    store.addMessage({
      toRole: "admin",
      itHandler: ticket.itHandler,
      requesterName: actor,
      action: `更新了工单「${ticket.title}」的 ${changeEntries.map((c) => c.field).join("、")} 字段`,
      time: dayjs().format("YYYY-MM-DD HH:mm"),
      ticketCode: ticket.code,
      read: false,
    });
  }

  res.json({ data: ticket });
});

router.post("/:id/claim", (req, res) => {
  const ticket = store.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ message: "工单不存在" });
  const { actor } = req.body as { actor: string };
  ticket.itHandler = actor;
  ticket.processingNotes.push({
    time: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    actor,
    content: "接单",
  });
  res.json({ data: ticket });
});

router.post("/:id/transfer", (req, res) => {
  const ticket = store.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ message: "工单不存在" });
  const { actor, to } = req.body as { actor: string; to: string };
  const oldHandler = ticket.itHandler;
  ticket.itHandler = to;
  ticket.processingNotes.push({
    time: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    actor,
    content: `转交给 ${to}`,
  });
  store.addChangeLog(ticket, [
    {
      field: "itHandler",
      oldValue: oldHandler,
      newValue: to,
      time: dayjs().format("YYYY-MM-DD HH:mm:ss"),
      actor,
    },
  ]);
  res.json({ data: ticket });
});

// 批量删除工单：勾选列表里的数据后手动删除。仅管理员可操作。
// 删除前把整份数据备份一次，误删可以整体回滚（backend/data/store-backup-<时间>.json）
router.post("/bulk-delete", (req, res) => {
  const { ids, actor, actorRole } = req.body as {
    ids?: string[];
    actor?: string;
    actorRole?: string;
  };
  if (actorRole !== "admin") {
    return res.status(403).json({ message: "仅管理员可以删除工单" });
  }
  if (!ids?.length) {
    return res.status(400).json({ message: "请先勾选要删除的工单" });
  }

  const target = new Set(ids);
  const matched = store.tickets.filter((t) => target.has(t.id));
  if (matched.length === 0) {
    return res.status(404).json({ message: "勾选的工单都不存在，可能已被删除" });
  }

  const backupFile = backupStoreFile();
  store.tickets = store.tickets.filter((t) => !target.has(t.id));
  store.save();

  const codes = matched.map((t) => t.code);
  store.addLog({
    type: "更新工单",
    time: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    actor: actor ?? "未知",
    success: true,
    failReason: null,
    detail:
      `手动删除工单 ${matched.length} 条：${codes.slice(0, 20).join("、")}` +
      `${codes.length > 20 ? ` 等${codes.length}条` : ""}` +
      `${backupFile ? `（删除前已备份到 ${backupFile}）` : ""}`,
  });

  res.json({ deletedCount: matched.length, codes, backupFile });
});

export default router;
