import { Router } from "express";
import dayjs from "dayjs";
import { store } from "../store";
import { applyFilters, canViewTicket, parseQuery, scopeForActor } from "../filter";
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
  const tickets = itHandler?.length ? store.tickets.filter((t) => itHandler.includes(t.itHandler)) : store.tickets;
  res.json({ data: computeCardStats(tickets) });
});

// 真实工单数据里出现过的 IT 受理人（去重排序），供"切换人员"等入口使用。
// 不用人员目录（store.users）是因为那份是预置的部门人员名单，跟真实工单里实际出现的
// 受理人不一定对得上：目录里有的人可能一条工单都没有，工单里的人也可能不在目录里
router.get("/it-handlers", (_req, res) => {
  const names = dedupe(store.tickets.map((t) => t.itHandler)).sort();
  const data = names.map((name) => {
    const matched = store.users.find((u) => u.name === name);
    return { id: matched?.id ?? name, name, avatarColor: matched?.avatarColor ?? "#999999" };
  });
  res.json({ data });
});

// 工单编号候选（仅关联了TAPD地址的），供"获取TAPD信息"弹窗里按单条工单编号选择使用
router.get("/codes", (_req, res) => {
  const codes = dedupe(store.tickets.filter((t) => t.tapdUrl).map((t) => t.code)).sort();
  res.json({ data: codes });
});

router.get("/", (req, res) => {
  const q = parseQuery(req.query as Record<string, unknown>);
  const { actor, actorRole } = req.query as { actor?: string; actorRole?: string };
  const scoped = scopeForActor(store.tickets, actor, actorRole);
  const filtered = applyFilters(scoped, q);

  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.pageSize ?? 20);
  const start = (page - 1) * pageSize;
  const pageData = filtered.slice(start, start + pageSize);

  // 下拉候选值以当前筛选结果为边界，不越界到全量数据
  const facets = {
    requesters: dedupe(filtered.map((t) => t.requester)).sort(),
    watchers: dedupe(filtered.flatMap((t) => t.watcher)).sort(),
    itHandlers: dedupe(filtered.map((t) => t.itHandler)).sort(),
    developers: dedupe(filtered.flatMap((t) => t.developer)).sort(),
    monthlyPlans: dedupe(filtered.flatMap((t) => t.monthlyPlan)).sort(),
    iterations: dedupe(filtered.flatMap((t) => t.iterations.map((i) => stripCurrentIterationTag(i.name)))).sort(),
    owningApps: dedupe(filtered.map((t) => t.owningApp)).sort(),
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

// 紧急、备注两个字段所有角色均可实时编辑，其余字段暂不支持通用编辑
const EDITABLE_FIELDS = ["urgent", "remark"] as const;

router.patch("/:id", (req, res) => {
  const ticket = store.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ message: "工单不存在" });

  const { fields, actor, actorRole } = req.body as {
    fields: Record<string, unknown>;
    actor: string;
    actorRole: string;
  };
  if (!actor) return res.status(400).json({ message: "缺少操作人信息，无法提交" });

  // IT 受理人仅可编辑自己负责的数据；需求方仅可编辑发起人或关注人包含本人的数据
  if (actorRole === "it_handler" && ticket.itHandler !== actor) {
    return res.status(403).json({ message: "无权限：仅能编辑本人负责的工单" });
  }
  if (actorRole === "requester" && !canViewTicket(ticket, actor, actorRole)) {
    return res.status(403).json({ message: "无权限：仅能编辑发起人或关注人包含本人的工单" });
  }

  const changeEntries: ChangeLogEntry[] = [];
  for (const key of Object.keys(fields)) {
    if (!EDITABLE_FIELDS.includes(key as any)) {
      return res.status(400).json({ message: `字段校验失败：${key} 不可编辑` });
    }
    const oldValue = String((ticket as any)[key]);
    const newValue = String((fields as any)[key]);
    if (oldValue !== newValue) {
      changeEntries.push({
        field: key,
        oldValue,
        newValue,
        time: dayjs().format("YYYY-MM-DD HH:mm:ss"),
        actor,
      });
      (ticket as any)[key] = (fields as any)[key];
    }
  }
  store.addChangeLog(ticket, changeEntries);
  ticket.processingNotes.push({
    time: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    actor,
    content: `更新字段：${changeEntries.map((c) => c.field).join("、") || "无变化"}`,
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

export default router;
