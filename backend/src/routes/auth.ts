import { Router } from "express";
import { store } from "../store";
import { Account } from "../types";

const router = Router();

function toSessionUser(account: Account) {
  const base = store.users.find((u) => u.id === account.userId);
  return {
    id: account.userId,
    name: account.name,
    pinyin: account.pinyin,
    role: account.role,
    departmentId: base?.departmentId ?? "",
    avatarColor: base?.avatarColor ?? "#999999",
  };
}

router.post("/login", (req, res) => {
  const { account } = req.body as { account?: string };
  if (!account || !account.trim()) {
    return res.status(400).json({ message: "请输入账号" });
  }
  const kw = account.trim().toLowerCase();
  const matched = store.accounts.find(
    (a) => a.name.toLowerCase() === kw || a.pinyin.toLowerCase() === kw
  );
  const admin = store.accounts.find((a) => a.role === "admin");
  if (!matched) {
    return res.status(404).json({
      message: "当前账号未授权，请联系管理员进行授权",
      adminName: admin?.name ?? "管理员",
    });
  }
  return res.json({ user: toSessionUser(matched) });
});

router.get("/me", (req, res) => {
  const { userId } = req.query as { userId?: string };
  const matched = store.accounts.find((a) => a.userId === userId);
  const admin = store.accounts.find((a) => a.role === "admin");
  if (!matched) {
    return res.status(404).json({
      message: "当前账号未授权，请联系管理员进行授权",
      adminName: admin?.name ?? "管理员",
    });
  }
  res.json({ user: toSessionUser(matched) });
});

router.get("/users", (req, res) => {
  const { role } = req.query as { role?: string };
  const list = role ? store.users.filter((u) => u.role === role) : store.users;
  res.json({ data: list });
});

export default router;
