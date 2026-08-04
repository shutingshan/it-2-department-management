import { Router } from "express";
import { v4 as uuid } from "uuid";
import { store } from "../store";
import { AccountRole, SYNC_PERMISSIONS, SyncPermission } from "../types";

const router = Router();

const ROLES: AccountRole[] = ["admin", "it_handler", "requester"];
const PERMISSION_KEYS = SYNC_PERMISSIONS.map((p) => p.key);

// 只保留合法的权限key，挡掉客户端乱传的值
function normalizePermissions(v: unknown): SyncPermission[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((k): k is SyncPermission => PERMISSION_KEYS.includes(k as SyncPermission));
}

// 账号一览：锁定的默认超级管理员账号排在最前
router.get("/", (_req, res) => {
  const list = [...store.accounts].sort((a, b) => (b.locked ? 1 : 0) - (a.locked ? 1 : 0));
  res.json({ data: list });
});

// 可选账号目录：用于新增/编辑弹窗中的"姓名"选择器，排除已配置账号的人员
router.get("/directory", (_req, res) => {
  const configuredUserIds = new Set(store.accounts.map((a) => a.userId));
  const available = store.users.filter((u) => !configuredUserIds.has(u.id));
  res.json({ data: available });
});

router.post("/", (req, res) => {
  const { userId, role, syncPermissions } = req.body as {
    userId?: string;
    role?: string;
    syncPermissions?: unknown;
  };
  if (!userId || !role) return res.status(400).json({ message: "请选择姓名和角色" });
  if (!ROLES.includes(role as AccountRole)) return res.status(400).json({ message: "角色不合法" });
  const user = store.users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ message: "所选人员不存在" });
  if (store.accounts.some((a) => a.userId === userId)) {
    return res.status(400).json({ message: "该人员已配置过账号" });
  }
  const account = {
    id: uuid(),
    userId: user.id,
    name: user.name,
    pinyin: user.pinyin,
    role: role as AccountRole,
    syncPermissions: normalizePermissions(syncPermissions) ?? [],
  };
  store.accounts.push(account);
  res.json({ data: account });
});

router.patch("/:id", (req, res) => {
  const account = store.accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ message: "账号不存在" });
  if (account.locked) return res.status(403).json({ message: "默认超级管理员账号不可编辑" });

  const { userId, role, syncPermissions } = req.body as {
    userId?: string;
    role?: string;
    syncPermissions?: unknown;
  };
  const nextPermissions = normalizePermissions(syncPermissions);
  if (nextPermissions) account.syncPermissions = nextPermissions;
  if (role) {
    if (!ROLES.includes(role as AccountRole)) return res.status(400).json({ message: "角色不合法" });
    account.role = role as AccountRole;
  }
  if (userId && userId !== account.userId) {
    const user = store.users.find((u) => u.id === userId);
    if (!user) return res.status(404).json({ message: "所选人员不存在" });
    if (store.accounts.some((a) => a.userId === userId && a.id !== account.id)) {
      return res.status(400).json({ message: "该人员已配置过账号" });
    }
    account.userId = user.id;
    account.name = user.name;
    account.pinyin = user.pinyin;
  }
  res.json({ data: account });
});

router.delete("/:id", (req, res) => {
  const account = store.accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ message: "账号不存在" });
  if (account.locked) return res.status(403).json({ message: "默认超级管理员账号不可删除" });
  store.accounts = store.accounts.filter((a) => a.id !== req.params.id);
  res.json({ ok: true });
});

export default router;
