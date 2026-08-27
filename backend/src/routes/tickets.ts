import { Router } from "express";
import dayjs from "dayjs";
import { store } from "../store";
import { applyFilters, parseQuery } from "../filter";
import { dedupe } from "../mapping";
import { isValidMonth, resolveExpectedMonthOptions } from "../settings";
import { ChangeLogEntry } from "../types";

const router = Router();

// 系统内全部月度计划取值（含子需求月度计划与已填写的需方期望月度），供「月度计划」筛选使用
function allMonthlyPlans(): string[] {
  return dedupe(
    store.tickets.flatMap((t) => [
      ...t.monthlyPlan,
      ...t.subTickets.flatMap((s) => s.monthlyPlan),
      ...(t.expectedMonth ? [t.expectedMonth] : []),
    ])
  ).sort();
}

router.get("/", (req, res) => {
  const q = parseQuery(req.query as Record<string, unknown>);
  const filtered = applyFilters(store.tickets, q);

  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.pageSize ?? 20);
  const start = (page - 1) * pageSize;
  const pageData = filtered.slice(start, start + pageSize);

  // 下拉候选值以当前筛选结果为边界，不越界到全量数据；
  // 月度计划例外：筛选与「需方期望月度」下拉都需要系统内全量月度值，否则筛掉一次就再也选不回来
  const facets = {
    requesters: dedupe(filtered.map((t) => t.requester)).sort(),
    itHandlers: dedupe(filtered.map((t) => t.itHandler)).sort(),
    developers: dedupe(filtered.flatMap((t) => t.developer)).sort(),
    monthlyPlans: allMonthlyPlans(),
    // 需方期望月度候选值按可配置的取值来源解析，默认取自月度计划字段
    expectedMonths: resolveExpectedMonthOptions(store.tickets),
    iterations: dedupe(filtered.flatMap((t) => t.iterations.map((i) => i.name))).sort(),
    owningApps: dedupe(filtered.map((t) => t.owningApp)).sort(),
  };

  res.json({ data: pageData, total: filtered.length, facets, lastUpdateTime: store.lastUpdateTime });
});

// 候选值单独暴露：详情抽屉等场景不需要为了取下拉值去拉整张列表
router.get("/options/monthly-plans", (_req, res) => {
  res.json({ data: allMonthlyPlans() });
});

router.get("/options/expected-months", (_req, res) => {
  res.json({ data: resolveExpectedMonthOptions(store.tickets) });
});

router.get("/:id", (req, res) => {
  const ticket = store.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ message: "工单不存在" });
  res.json({ data: ticket });
});

const EDITABLE_FIELDS = ["urgent", "itHandler", "category", "module", "expectedMonth"] as const;

// 需求方角色可自行维护的字段
const REQUESTER_FIELDS = ["urgent", "expectedMonth"];

// 变更记录展示值：null/undefined 统一记为空字符串，避免写入字面量 "null"
function displayValue(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

router.patch("/:id", (req, res) => {
  const ticket = store.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ message: "工单不存在" });

  const { fields, actor, actorRole } = req.body as {
    fields: Record<string, unknown>;
    actor: string;
    actorRole: string;
  };
  if (!actor) return res.status(400).json({ message: "缺少操作人信息，无法提交" });

  // 需求方角色仅能编辑紧急、需方期望月度字段
  if (actorRole === "requester") {
    const disallowed = Object.keys(fields).filter((k) => !REQUESTER_FIELDS.includes(k));
    if (disallowed.length) {
      return res.status(403).json({
        message: `权限不足：需求方仅可编辑紧急、需方期望月度字段，无法修改 ${disallowed.join(",")}`,
      });
    }
  }

  const expectedMonth = fields.expectedMonth;
  if (
    "expectedMonth" in fields &&
    expectedMonth !== null &&
    expectedMonth !== "" &&
    !(typeof expectedMonth === "string" && isValidMonth(expectedMonth))
  ) {
    return res.status(400).json({ message: "字段校验失败：需方期望月度需为 YYYY-MM 格式" });
  }
  if (fields.expectedMonth === "") fields.expectedMonth = null;

  const changeEntries: ChangeLogEntry[] = [];
  for (const key of Object.keys(fields)) {
    if (!EDITABLE_FIELDS.includes(key as any)) {
      return res.status(400).json({ message: `字段校验失败：${key} 不可编辑` });
    }
    const oldValue = displayValue((ticket as any)[key]);
    const newValue = displayValue((fields as any)[key]);
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
