import { Router } from "express";
import { store } from "../store";

const router = Router();

router.get("/", (req, res) => {
  res.json({ data: store.logs });
});

export default router;
