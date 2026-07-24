import { Router } from "express";
import { store } from "../store";

const router = Router();

router.get("/", (req, res) => {
  const roots = store.departments.filter((d) => d.parentId === null);
  const tree = roots.map((r) => ({
    ...r,
    children: store.departments.filter((d) => d.parentId === r.id),
  }));
  res.json({ data: tree });
});

export default router;
