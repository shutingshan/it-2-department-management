import { Router } from "express";
import { v4 as uuid } from "uuid";
import { store } from "../store";
import { ScopeConfigItem } from "../types";
import { dedupe } from "../mapping";

const router = Router();

// 三类范围各一张表，路径上用 kind 区分，避免写三套一模一样的增删改查。
// 注意 excludedApps 是排除语义（配了就不显示），另外两类是保留语义（配了就只显示这些）
type ScopeKind = "handlers" | "categories" | "excludedApps" | "verifyCodes";
const KIND_LABELS: Record<ScopeKind, string> = {
  handlers: "受理人",
  categories: "工单分类",
  excludedApps: "归属应用",
  verifyCodes: "校验工单编号",
};

function isKind(v: string): v is ScopeKind {
  return v === "handlers" || v === "categories" || v === "excludedApps" || v === "verifyCodes";
}

function listOf(kind: ScopeKind): ScopeConfigItem[] {
  if (kind === "handlers") return store.fetchScopeHandlers;
  if (kind === "categories") return store.displayCategories;
  if (kind === "excludedApps") return store.excludedOwningApps;
  return store.verifyTicketCodes;
}

function setList(kind: ScopeKind, list: ScopeConfigItem[]) {
  if (kind === "handlers") store.fetchScopeHandlers = list;
  else if (kind === "categories") store.displayCategories = list;
  else if (kind === "excludedApps") store.excludedOwningApps = list;
  else store.verifyTicketCodes = list;
}

/** 当前配置。为空时前端要提示「未配置＝不限制 / 不排除」 */
router.get("/", (_req, res) => {
  res.json({
    data: {
      handlers: store.fetchScopeHandlers,
      categories: store.displayCategories,
      excludedApps: store.excludedOwningApps,
      verifyCodes: store.verifyTicketCodes,
    },
  });
});

/**
 * 候选值：从已有工单数据里去重取出，供页面下拉选择。
 * 页面同时允许手输，用于新同事、新分类还没有任何工单的情况。
 * 三类候选一律取自全量工单，不受任何范围配置影响——否则配了分类之后就选不到
 * 其他分类里的受理人，排除掉一个归属应用之后也没法再把它从排除名单里认出来
 */
router.get("/options", (_req, res) => {
  res.json({
    data: {
      handlers: dedupe(store.tickets.map((t) => t.itHandler).filter((v) => v && v.trim())).sort(),
      categories: dedupe(store.tickets.map((t) => t.category).filter((v) => v && v.trim())).sort(),
      excludedApps: dedupe(store.tickets.map((t) => t.owningApp).filter((v) => v && v.trim())).sort(),
      // 校验工单候选只给显示范围内、且已完成的：核验用的工单必须是使用者在工单中心
      // 能看到的，否则校验失败时连那条工单都查不到；已完成的工单不会再变动，最稳定
      verifyCodes: dedupe(
        store.visibleTickets.filter((t) => t.stage === "已完成").map((t) => t.code).filter((v) => v && v.trim())
      ).sort(),
    },
  });
});

router.post("/:kind", (req, res) => {
  const { kind } = req.params;
  if (!isKind(kind)) return res.status(400).json({ message: "配置类型不合法" });
  const value = String((req.body as { value?: unknown }).value ?? "").trim();
  if (!value) return res.status(400).json({ message: `请输入${KIND_LABELS[kind]}` });

  const list = listOf(kind);
  if (list.some((i) => i.value === value)) {
    return res.status(400).json({ message: `${KIND_LABELS[kind]}「${value}」已存在，无需重复添加` });
  }
  const item: ScopeConfigItem = { id: uuid(), value };
  list.push(item);
  store.save();
  res.json({ data: item });
});

router.patch("/:kind/:id", (req, res) => {
  const { kind, id } = req.params;
  if (!isKind(kind)) return res.status(400).json({ message: "配置类型不合法" });
  const list = listOf(kind);
  const item = list.find((i) => i.id === id);
  if (!item) return res.status(404).json({ message: "该配置项不存在，可能已被删除" });

  const value = String((req.body as { value?: unknown }).value ?? "").trim();
  if (!value) return res.status(400).json({ message: `请输入${KIND_LABELS[kind]}` });
  if (list.some((i) => i.id !== id && i.value === value)) {
    return res.status(400).json({ message: `${KIND_LABELS[kind]}「${value}」已存在` });
  }
  item.value = value;
  store.save();
  res.json({ data: item });
});

router.delete("/:kind/:id", (req, res) => {
  const { kind, id } = req.params;
  if (!isKind(kind)) return res.status(400).json({ message: "配置类型不合法" });
  const list = listOf(kind);
  const idx = list.findIndex((i) => i.id === id);
  if (idx === -1) return res.status(404).json({ message: "该配置项不存在，可能已被删除" });
  const [removed] = list.splice(idx, 1);
  setList(kind, list);
  store.save();
  res.json({ data: removed });
});

export default router;
