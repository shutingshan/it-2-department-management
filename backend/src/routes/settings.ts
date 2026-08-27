import { Router } from "express";
import { store } from "../store";
import {
  getExpectedMonthSource,
  resolveExpectedMonthOptions,
  updateExpectedMonthSource,
  validateExpectedMonthSource,
} from "../settings";
import { ExpectedMonthSource } from "../types";

const router = Router();

function payload() {
  return {
    data: getExpectedMonthSource(),
    // 一并返回按该配置解析出的候选值，前端保存后可直接预览生效结果
    options: resolveExpectedMonthOptions(store.tickets),
  };
}

router.get("/expected-month-source", (_req, res) => {
  res.json(payload());
});

router.put("/expected-month-source", (req, res) => {
  const { actorRole, ...rest } = req.body as { actorRole?: string } & ExpectedMonthSource;
  if (actorRole !== "admin") {
    return res.status(403).json({ message: "权限不足：仅管理员可修改需方期望月度取值来源" });
  }

  const error = validateExpectedMonthSource(rest);
  if (error) return res.status(400).json({ message: `配置校验失败：${error}` });

  updateExpectedMonthSource(rest as ExpectedMonthSource);
  res.json(payload());
});

export default router;
