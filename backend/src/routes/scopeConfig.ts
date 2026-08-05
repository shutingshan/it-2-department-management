import { Router } from "express";
import { v4 as uuid } from "uuid";
import { store } from "../store";
import { ScopeConfigItem } from "../types";
import { dedupe } from "../mapping";

const router = Router();

// 两类范围各一张表，路径上用 kind 区分，避免写两套一模一样的增删改查
type ScopeKind = "handlers" | "categories";
const KIND_LABELS: Record<ScopeKind, string> = { handlers: "受理人", categories: "工单分类" };

function isKind(v: string): v is ScopeKind {
  return v === "handlers" || v === "categories";
}

function listOf(kind: ScopeKind): ScopeConfigItem[] {
  return kind === "handlers" ? store.fetchScopeHandlers : store.displayCategories;
}

function setList(kind: ScopeKind, list: ScopeConfigItem[]) {
  if (kind === "handlers") store.fetchScopeHandlers = list;
  else store.displayCategories = list;
}

/** 当前配置。两类都为空时前端要提示「未配置＝不限制」 */
router.get("/", (_req, res) => {
  res.json({
    data: {
      handlers: store.fetchScopeHandlers,
      categories: store.displayCategories,
    },
  });
});

/**
 * 候选值：从已有工单数据里去重取出，供页面下拉选择。
 * 页面同时允许手输，用于新同事、新分类还没有任何工单的情况。
 * 受理人候选取自全量工单，不受分类显示范围影响——否则配了分类之后就选不到
 * 其他分类里的受理人了
 */
router.get("/options", (_req, res) => {
  res.json({
    data: {
      handlers: dedupe(store.tickets.map((t) => t.itHandler).filter((v) => v && v.trim())).sort(),
      categories: dedupe(store.tickets.map((t) => t.category).filter((v) => v && v.trim())).sort(),
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
