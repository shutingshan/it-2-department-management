import { Department } from "./types";
import { store } from "./store";

export function getDept(id: string): Department | undefined {
  return store.departments.find((d) => d.id === id);
}

export function getDeptName(id: string): string {
  return getDept(id)?.name ?? id;
}

// 顶层（父级）部门 id：一路向上找到没有 parentId 的祖先
export function getRootDeptId(id: string): string {
  let current = getDept(id);
  while (current && current.parentId) {
    const parent = getDept(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current?.id ?? id;
}

export function getChildDeptIds(parentId: string): string[] {
  return store.departments.filter((d) => d.parentId === parentId).map((d) => d.id);
}

export function getTopLevelDepartments(): Department[] {
  return store.departments.filter((d) => d.parentId === null);
}
