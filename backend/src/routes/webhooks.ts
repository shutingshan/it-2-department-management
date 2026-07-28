/**
 * 供 TAPD 反向调用的 Webhook 接口：TAPD 里某条需求变更时主动通知本系统，
 * 本系统据此更新对应工单编号的相关字段，不用等下一次定时同步。
 *
 * 安全说明：这是一个对公网暴露的写入接口，必须带口令才能调用。口令配置在
 * backend/.env 的 TAPD_WEBHOOK_TOKEN，未配置时接口直接拒绝服务（fail closed），
 * 避免有人猜到地址就能改数据。
 *
 * 字段口径：不直接采信推送报文里的字段值（报文结构随 TAPD 配置/版本变化，容易对不上），
 * 而是拿到"是哪条需求变了"之后，回头调一次 TAPD 开放平台 API 取权威数据，
 * 再走跟手动同步完全相同的那套字段应用逻辑（syncSingleTicketTapd），保证两条路径口径一致。
 */
import { Router } from "express";
import { store } from "../store";
import { syncSingleTicketTapd } from "./sync";
import { parseTapdRef } from "../scrapers/tapdApi";

const router = Router();

const WEBHOOK_ACTOR = "TAPD推送";

// 报文里"需求id"可能叫 id/story_id，也可能嵌在 data/story 之类的外层对象里，
// 这里按常见位置逐个找，找不到再交给按工单编号兜底匹配
function extractStoryId(payload: any): string | null {
  const candidates = [
    payload?.id,
    payload?.story_id,
    payload?.data?.id,
    payload?.data?.story_id,
    payload?.story?.id,
    payload?.Story?.id,
    payload?.event_source_id,
  ];
  for (const v of candidates) {
    const s = v === null || v === undefined ? "" : String(v).trim();
    if (/^\d+$/.test(s)) return s;
  }
  return null;
}

// 兜底匹配：把整个报文序列化后，看看里面有没有出现本系统已有的工单编号
// （只会匹配到系统里已存在的编号，不会凭空造数据）
function findTicketByCodeInPayload(payload: any) {
  let text = "";
  try {
    text = JSON.stringify(payload);
  } catch {
    return undefined;
  }
  return store.tickets.find((t) => t.code && text.includes(t.code));
}

router.post("/tapd", async (req, res) => {
  const expected = process.env.TAPD_WEBHOOK_TOKEN;
  if (!expected) {
    return res.status(503).json({
      message: "Webhook 未启用：请先在 backend/.env 配置 TAPD_WEBHOOK_TOKEN 后重启服务",
    });
  }
  const provided = (req.query.token as string) ?? req.header("x-webhook-token") ?? "";
  if (provided !== expected) {
    return res.status(401).json({ message: "口令校验失败" });
  }

  const payload = req.body;

  // 优先按需求id匹配（工单里存的TAPD地址中带着需求id），匹配不到再按工单编号兜底
  const storyId = extractStoryId(payload);
  let ticket = storyId
    ? store.tickets.find((t) => t.tapdUrl && parseTapdRef(t.tapdUrl)?.storyId === storyId)
    : undefined;
  if (!ticket) ticket = findTicketByCodeInPayload(payload);

  if (!ticket) {
    // 找不到对应工单不算调用方的错（可能是本系统还没同步到这条工单，或该需求本来就没关联工单），
    // 返回 200 避免 TAPD 反复重推，同时记一条日志方便排查
    console.warn(
      `[webhook] 收到TAPD推送但未匹配到工单（需求id：${storyId ?? "未解析出"}），报文：`,
      JSON.stringify(payload).slice(0, 500)
    );
    return res.json({ matched: false, message: "未匹配到对应工单，已忽略" });
  }

  try {
    // 复用手动同步那套逻辑：回查TAPD API取权威数据 -> 应用字段 -> 重算工单阶段 -> 记日志，
    // 失败也会照常写入"TAPD异常备注"
    await syncSingleTicketTapd(ticket, WEBHOOK_ACTOR);
    res.json({ matched: true, code: ticket.code });
  } catch (e) {
    res.status(500).json({ matched: true, code: ticket.code, message: (e as Error).message });
  }
});

export default router;
