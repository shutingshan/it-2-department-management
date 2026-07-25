import { Router } from "express";
import dayjs from "dayjs";
import { store } from "../store";
import { applyFilters, parseQuery } from "../filter";
import { dedupe } from "../mapping";
import { ChangeLogEntry } from "../types";

const router = Router();

router.get("/", (req, res) => {
  const q = parseQuery(req.query as Record<string, unknown>);
  const filtered = applyFilters(store.tickets, q);

  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.pageSize ?? 20);
  const start = (page - 1) * pageSize;
  const pageData = filtered.slice(start, start + pageSize);

  // 下拉候选值以当前筛选结果为边界，不越界到全量数据
  const facets = {
    requesters: dedupe(filtered.map((t) => t.requester)).sort(),
    itHandlers: dedupe(filtered.map((t) => t.itHandler)).sort(),
    developers: dedupe(filtered.flatMap((t) => t.developer)).sort(),
    monthlyPlans: dedupe(filtered.flatMap((t) => t.monthlyPlan)).sort(),
    iterations: dedupe(filtered.flatMap((t) => t.iterations.map((i) => i.name))).sort(),
    owningApps: dedupe(filtered.map((t) => t.owningApp)).sort(),
  };

  res.json({ data: pageData, total: filtered.length, facets, lastUpdateTime: store.lastUpdateTime });
});

router.get("/:id", (req, res) => {
  const ticket = store.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ message: "工单不存在" });
  res.json({ data: ticket });
});

const EDITABLE_FIELDS = ["urgent", "itHandler", "category", "module"] as const;

router.patch("/:id", (req, res) => {
  const ticket = store.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ message: "工单不存在" });

  const { fields, actor, actorRole } = req.body as {
    fields: Record<string, unknown>;
    actor: string;
    actorRole: string;
  };
  if (!actor) return res.status(400).json({ message: "缺少操作人信息，无法提交" });

  // 需求方角色仅能编辑紧急字段
  if (actorRole === "requester") {
    const disallowed = Object.keys(fields).filter((k) => k !== "urgent");
    if (disallowed.length) {
      return res.status(403).json({
        message: `权限不足：需求方仅可编辑紧急字段，无法修改 ${disallowed.join(",")}`,
      });
    }
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
