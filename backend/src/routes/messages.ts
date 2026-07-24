import { Router } from "express";
import { store } from "../store";

const router = Router();

router.get("/", (req, res) => {
  const { read } = req.query as { read?: string };
  let list = store.messages;
  if (read === "true") list = list.filter((m) => m.read);
  if (read === "false") list = list.filter((m) => !m.read);
  res.json({ data: list, unreadCount: store.messages.filter((m) => !m.read).length });
});

router.patch("/:id/read", (req, res) => {
  const msg = store.messages.find((m) => m.id === req.params.id);
  if (!msg) return res.status(404).json({ message: "消息不存在" });
  msg.read = true;
  res.json({ data: msg });
});

router.post("/read-all", (req, res) => {
  store.messages.forEach((m) => (m.read = true));
  res.json({ data: store.messages });
});

export default router;
