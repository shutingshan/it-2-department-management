import { Router } from "express";
import { v4 as uuid } from "uuid";
import { store } from "../store";
import { DefectTreeNode } from "../types";
import { dedupe } from "../mapping";

const router = Router();

// 归属应用可以留空：先建好分组、之后再往里挂应用是常见做法，不该被挡住
function normalizeApps(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return dedupe(v.map((x) => String(x).trim()).filter(Boolean));
}

/** 当前配置。为空时前端按"原始形态"（一个归属应用一个节点）渲染树 */
router.get("/", (_req, res) => {
  res.json({ data: store.defectTreeNodes });
});

/**
 * 可选的归属应用：取自缺陷范围内的真实工单，而不是全量工单——
 * 配了也挂不上缺陷的应用列在这里只会让人以为配错了
 */
router.get("/options", (_req, res) => {
  const apps = dedupe(store.defectVisibleTickets.map((t) => t.owningApp).filter((v) => v && v.trim())).sort();
  res.json({ data: apps });
});

router.post("/", (req, res) => {
  const { name, apps } = req.body as { name?: unknown; apps?: unknown };
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return res.status(400).json({ message: "请输入节点名称" });
  if (store.defectTreeNodes.some((n) => n.name === trimmed)) {
    return res.status(400).json({ message: `节点「${trimmed}」已存在` });
  }
  const node: DefectTreeNode = { id: uuid(), name: trimmed, apps: normalizeApps(apps) };
  store.defectTreeNodes.push(node);
  store.save();
  res.json({ data: node });
});

router.patch("/:id", (req, res) => {
  const node = store.defectTreeNodes.find((n) => n.id === req.params.id);
  if (!node) return res.status(404).json({ message: "该节点不存在，可能已被删除" });

  const { name, apps } = req.body as { name?: unknown; apps?: unknown };
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) return res.status(400).json({ message: "请输入节点名称" });
    if (store.defectTreeNodes.some((n) => n.id !== node.id && n.name === trimmed)) {
      return res.status(400).json({ message: `节点「${trimmed}」已存在` });
    }
    node.name = trimmed;
  }
  if (apps !== undefined) node.apps = normalizeApps(apps);
  store.save();
  res.json({ data: node });
});

router.delete("/:id", (req, res) => {
  const idx = store.defectTreeNodes.findIndex((n) => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ message: "该节点不存在，可能已被删除" });
  const [removed] = store.defectTreeNodes.splice(idx, 1);
  store.save();
  res.json({ data: removed });
});

export default router;
