import { Router } from "express";
import { store } from "../store";

const router = Router();

// 字段名 -> 中文变更类型展示
const FIELD_LABELS: Record<string, string> = {
  urgent: "紧急",
  remark: "备注",
  stage: "工单阶段",
  status: "状态",
  itHandler: "IT受理人",
};

// 数据变更：谁在什么时候变更了工单的某个字段（汇总自各工单的变更记录）
router.get("/data-changes", (_req, res) => {
  const list = store.tickets
    .flatMap((t) =>
      t.changeHistory.map((c) => ({
        id: `${t.id}-${c.field}-${c.time}`,
        actor: c.actor,
        changeType: FIELD_LABELS[c.field] ?? c.field,
        detail: `工单 ${t.code}：${FIELD_LABELS[c.field] ?? c.field} 由「${c.oldValue}」变更为「${c.newValue}」`,
        time: c.time,
      }))
    )
    .sort((a, b) => (a.time < b.time ? 1 : -1));
  res.json({ data: list });
});

// 数据同步：按钮名称（获取新工单/更新工单/同步TAPD）执行情况；触发点区分"人工点击（操作人姓名）"与"定时任务"
router.get("/sync-logs", (_req, res) => {
  const list = store.logs.map((l) => ({
    id: l.id,
    buttonName: l.type,
    trigger: l.actor,
    changeType: l.success ? "成功" : "失败",
    detail: l.success || !l.failReason ? l.detail : `${l.detail}：${l.failReason}`,
    time: l.time,
  }));
  res.json({ data: list });
});

export default router;
