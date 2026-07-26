import { Router } from "express";
import { v4 as uuid } from "uuid";
import { store } from "../store";
import { Department } from "../types";

const router = Router();

interface DeptNode extends Department {
  children: DeptNode[];
}

function buildTree(parentId: string | null): DeptNode[] {
  return store.departments
    .filter((d) => d.parentId === parentId)
    .map((d) => ({ ...d, children: buildTree(d.id) }));
}

// targetId 是否是 ancestorId 的后代（用于避免循环引用）
function isDescendant(ancestorId: string, targetId: string): boolean {
  const children = store.departments.filter((d) => d.parentId === ancestorId);
  return children.some((c) => c.id === targetId || isDescendant(c.id, targetId));
}

// 部门数据源来源于工单的发起部门：这里仅提供层级关系的增删改查，不改变工单已引用的部门 id 语义
router.get("/", (_req, res) => {
  res.json({ data: buildTree(null) });
});

router.get("/flat", (_req, res) => {
  res.json({ data: store.departments });
});

function findChildConflicts(childIds: string[], selfId: string | null) {
  return childIds
    .map((cid) => store.departments.find((d) => d.id === cid))
    .filter((d): d is Department => !!d && d.parentId !== null && d.parentId !== selfId);
}

router.post("/", (req, res) => {
  const { name, parentId, childIds } = req.body as {
    name?: string;
    parentId?: string | null;
    childIds?: string[];
  };
  if (!name || !name.trim()) return res.status(400).json({ message: "请输入部门名称" });
  if (parentId && !store.departments.some((d) => d.id === parentId)) {
    return res.status(400).json({ message: "所选上级部门不存在" });
  }
  if (childIds?.length) {
    const conflicts = findChildConflicts(childIds, null);
    if (conflicts.length) {
      return res.status(400).json({
        message: `以下部门已存在于其他父级部门下，无法重复设置为下级：${conflicts.map((d) => d.name).join("、")}`,
      });
    }
  }

  const id = `dept-${uuid().slice(0, 8)}`;
  const dept: Department = { id, name: name.trim(), parentId: parentId ?? null };
  store.departments.push(dept);
  childIds?.forEach((cid) => {
    const child = store.departments.find((d) => d.id === cid);
    if (child) child.parentId = id;
  });
  res.json({ data: dept });
});

router.patch("/:id", (req, res) => {
  const dept = store.departments.find((d) => d.id === req.params.id);
  if (!dept) return res.status(404).json({ message: "部门不存在" });

  const { name, parentId, childIds } = req.body as {
    name?: string;
    parentId?: string | null;
    childIds?: string[];
  };

  if (parentId !== undefined && parentId !== null) {
    if (parentId === dept.id) {
      return res.status(400).json({ message: "上级部门不能是自己" });
    }
    if (!store.departments.some((d) => d.id === parentId)) {
      return res.status(400).json({ message: "所选上级部门不存在" });
    }
    if (isDescendant(dept.id, parentId)) {
      return res.status(400).json({ message: "不能将下级部门设置为自己的上级部门" });
    }
  }

  if (childIds) {
    if (childIds.includes(dept.id)) {
      return res.status(400).json({ message: "下级部门不能包含自己" });
    }
    const conflicts = findChildConflicts(childIds, dept.id);
    if (conflicts.length) {
      return res.status(400).json({
        message: `以下部门已存在于其他父级部门下，无法重复设置为下级：${conflicts.map((d) => d.name).join("、")}`,
      });
    }
    // 循环引用校验：所选下级不能是本部门的祖先（否则会形成环）
    const cycles = childIds
      .map((cid) => store.departments.find((d) => d.id === cid))
      .filter((d): d is Department => !!d && isDescendant(d.id, dept.id));
    if (cycles.length) {
      return res.status(400).json({
        message: `以下部门是本部门的上级，不能反过来设置为下级：${cycles.map((d) => d.name).join("、")}`,
      });
    }
  }

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ message: "请输入部门名称" });
    dept.name = name.trim();
  }
  if (parentId !== undefined) {
    dept.parentId = parentId;
  }
  if (childIds) {
    // 未在新列表中的原有子部门，移除父子关系（变为顶级部门）
    store.departments.forEach((d) => {
      if (d.parentId === dept.id && !childIds.includes(d.id)) {
        d.parentId = null;
      }
    });
    childIds.forEach((cid) => {
      const child = store.departments.find((d) => d.id === cid);
      if (child) child.parentId = dept.id;
    });
  }

  res.json({ data: dept });
});

router.delete("/:id", (req, res) => {
  const dept = store.departments.find((d) => d.id === req.params.id);
  if (!dept) return res.status(404).json({ message: "部门不存在" });
  const hasChildren = store.departments.some((d) => d.parentId === dept.id);
  if (hasChildren) {
    return res.status(400).json({ message: "该部门下存在子部门，请先移除或调整子部门后再删除" });
  }
  const referencedByTicket = store.tickets.some((t) => t.requesterDept === dept.id);
  if (referencedByTicket) {
    return res.status(400).json({ message: "该部门已被工单引用（发起部门），无法删除" });
  }
  store.departments = store.departments.filter((d) => d.id !== dept.id);
  res.json({ ok: true });
});

export default router;
