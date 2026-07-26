import dayjs from "dayjs";
import { v4 as uuid } from "uuid";
import { resolveStage } from "../mapping";
import { Attachment, Ticket, TicketStatus } from "../types";
import { ScrapedRow } from "./dangquyunScraper";

const KNOWN_STATUSES: TicketStatus[] = [
  "待处理",
  "梳理中",
  "已梳理",
  "规划中",
  "开发完成",
  "实现中",
  "转测试",
  "测试中",
  "待验收",
  "已验收",
  "已解决",
  "已完成",
  "关闭",
];

function emptyToNull(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  return t === "" || t === "-" ? null : t;
}

function parseStatus(v: string | undefined): TicketStatus {
  const t = (v ?? "").trim() as TicketStatus;
  return KNOWN_STATUSES.includes(t) ? t : "待处理";
}

function parseAttachments(v: string | undefined): Attachment[] {
  const t = emptyToNull(v);
  if (!t) return [];
  return t.split(/[、,，]/).map((name) => ({ name: name.trim(), url: "#" }));
}

function parseDeveloperList(v: string | undefined): string[] {
  const t = emptyToNull(v);
  if (!t) return [];
  return Array.from(new Set(t.split(/[、,，]/).map((s) => s.trim()).filter(Boolean)));
}

/**
 * 把当曲云抓取到的一行（中文字段的自由文本）转换成系统内部的 Ticket。
 *
 * 几处当曲云字段跟系统字段不是严格一一对应，先按下面的假设处理，
 * 后续需要业务确认后再调整：
 * - 优先级：单独存成 priority 字段，不影响"紧急"（urgent 留给需求方等角色手动维护）
 * - 工时：预估/实际工时不从当曲云取，统一走 TAPD 同步口径，这里保留已有值（新建工单则为 0）
 * - 所属部门：当曲云给的是部门名称文本，不是系统内部预设的部门树 id，
 *   这里直接把部门名称原样存进 requesterDept，部门统计的下钻树形结构暂时对不上
 */
export function mapScrapedRowToTicket(row: ScrapedRow, existing?: Ticket): Ticket {
  const status = parseStatus(row["状态"]);
  const devStatus = existing?.devStatus ?? null; // 当曲云本身不带 TAPD 需求开发状态，沿用已有值，等 TAPD 同步再更新
  const iterations = existing?.iterations ?? [];
  const stage = resolveStage(status, devStatus, iterations);

  const tapdUrl = emptyToNull(row["关联TAPD"]);
  const developer = parseDeveloperList(row["开发人员"]);
  const handler = emptyToNull(row["受理人"]) ?? "";
  const expectedCompleteTime = emptyToNull(row["预计完成"]) ?? emptyToNull(row["期望完成"]);
  const actualCompleteTime = emptyToNull(row["实际完成"]);
  const submittedAt = emptyToNull(row["提交时间"]) ?? dayjs().format("YYYY-MM-DD");

  return {
    id: existing?.id ?? uuid(),
    code: row["编号"]?.trim() ?? "",
    tapdUrl,
    category: row["分类"]?.trim() || "-",
    owningApp: row["归属应用"]?.trim() || "-",
    module: row["功能模块"]?.trim() || "-",
    title: row["标题"]?.trim() || "",
    content: row["内容"]?.trim() || "",
    attachments: parseAttachments(row["附件"]),
    requester: row["发起人"]?.trim() || "",
    requesterPinyin: existing?.requesterPinyin ?? "",
    requesterDept: row["所属部门"]?.trim() || "",
    watcher: existing?.watcher ?? [],
    currentHandler: developer[0] ?? handler,
    itHandler: handler,
    developer,
    stage,
    status,
    devStatus,
    urgent: existing?.urgent ?? false,
    remark: existing?.remark ?? "",
    priority: emptyToNull(row["优先级"]),
    isReturned: existing?.isReturned ?? false,
    monthlyPlan: existing?.monthlyPlan ?? [],
    iterations,
    expectedTriageTime: emptyToNull(row["预计梳理完成"]),
    actualTriageTime: existing?.actualTriageTime ?? null,
    expectedCompleteTime,
    actualCompleteTime,
    estimatedHours: existing?.estimatedHours ?? 0,
    actualHours: existing?.actualHours ?? 0,
    submittedAt,
    closedAt: status === "关闭" ? actualCompleteTime : null,
    subTickets: existing?.subTickets ?? [],
    processingNotes: existing?.processingNotes ?? [
      {
        time: dayjs().format("YYYY-MM-DD HH:mm:ss"),
        actor: "系统同步",
        content: "从当曲云同步创建",
      },
    ],
    changeHistory: existing?.changeHistory ?? [],
    slaFlag: emptyToNull(row["SLA"]),
    tapdErrorNote: existing?.tapdErrorNote ?? null,
    dangquyunErrorNote: existing?.dangquyunErrorNote ?? null,
  };
}
