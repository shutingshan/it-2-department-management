import { Router } from "express";
import { store } from "../store";

const router = Router();

router.post("/login", (req, res) => {
  const { account } = req.body as { account?: string };
  if (!account || !account.trim()) {
    return res.status(400).json({ message: "请输入账号" });
  }
  const kw = account.trim().toLowerCase();
  const user = store.users.find(
    (u) => u.name.toLowerCase() === kw || u.pinyin.toLowerCase() === kw
  );
  const admin = store.users.find((u) => u.role === "admin");
  if (!user) {
    return res.status(404).json({
      message: "账号不存在",
      adminName: admin?.name ?? "管理员",
    });
  }
  return res.json({ user });
});

router.get("/me", (req, res) => {
  const { userId } = req.query as { userId?: string };
  const user = store.users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ message: "账号不存在" });
  res.json({ user });
});

router.get("/users", (req, res) => {
  const { role } = req.query as { role?: string };
  const list = role ? store.users.filter((u) => u.role === role) : store.users;
  res.json({ data: list });
});

export default router;
