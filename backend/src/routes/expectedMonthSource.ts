import { Router } from "express";
import { store } from "../store";
import {
  normalizeExpectedMonthSource,
  resolveExpectedMonthOptions,
  validateExpectedMonthSource,
} from "../expectedMonth";
import { ExpectedMonthSource } from "../types";

const router = Router();

function payload() {
  return {
    data: store.expectedMonthSource,
    // 一并返回按该配置解析出的候选值，页面上可以直接看到配置改完的实际效果
    options: resolveExpectedMonthOptions(store.tickets, store.expectedMonthSource),
  };
}

router.get("/", (_req, res) => {
  res.json(payload());
});

// 角色一律以账号记录为准，不认前端传上来的 actorRole——那个值谁都能改
// （同 permissions.canAccessDefects 的取舍）
function isAdmin(actor?: string): boolean {
  if (!actor) return false;
  return store.accounts.find((a) => a.name === actor)?.role === "admin";
}

router.put("/", (req, res) => {
  const { actor, ...rest } = req.body as { actor?: string } & ExpectedMonthSource;
  if (!isAdmin(actor)) {
    return res.status(403).json({ message: "权限不足：仅管理员可修改需方期望月度的取值来源" });
  }

  const error = validateExpectedMonthSource(rest);
  if (error) return res.status(400).json({ message: `配置校验失败：${error}` });

  store.expectedMonthSource = normalizeExpectedMonthSource(rest as ExpectedMonthSource);
  store.save();
  res.json(payload());
});

export default router;
