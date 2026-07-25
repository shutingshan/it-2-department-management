import { Router } from "express";
import { store } from "../store";

const router = Router();

// 站内信按 IT 受理人隔离：管理员可查看全部数据，但不能代替他人标记已读；
// 非管理员只能看到与自己相关（itHandler 为本人）的消息
router.get("/", (req, res) => {
  const { read, actor, actorRole } = req.query as {
    read?: string;
    actor?: string;
    actorRole?: string;
  };
  let list = actorRole === "admin" ? store.messages : store.messages.filter((m) => m.itHandler === actor);
  if (read === "true") list = list.filter((m) => m.read);
  if (read === "false") list = list.filter((m) => !m.read);
  const unreadCount =
    (actorRole === "admin" ? store.messages : store.messages.filter((m) => m.itHandler === actor)).filter(
      (m) => !m.read
    ).length;
  res.json({ data: list, unreadCount });
});

router.patch("/:id/read", (req, res) => {
  const msg = store.messages.find((m) => m.id === req.params.id);
  if (!msg) return res.status(404).json({ message: "消息不存在" });
  const { actor, actorRole } = req.body as { actor: string; actorRole: string };
  if (actorRole === "admin") {
    return res.status(403).json({ message: "管理员可查看全部站内信，但不能代替他人标记为已读" });
  }
  if (msg.itHandler !== actor) {
    return res.status(403).json({ message: "只有该工单的 IT 受理人可以将消息标记为已读" });
  }
  msg.read = true;
  res.json({ data: msg });
});

router.post("/read-all", (req, res) => {
  const { actor, actorRole } = req.body as { actor: string; actorRole: string };
  if (actorRole === "admin") {
    return res.status(403).json({ message: "管理员可查看全部站内信，但不能代替他人标记为已读" });
  }
  store.messages.filter((m) => m.itHandler === actor).forEach((m) => (m.read = true));
  res.json({ data: store.messages.filter((m) => m.itHandler === actor) });
});

export default router;
