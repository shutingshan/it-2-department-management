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

// 多人字段的分隔符：当曲云里顿号/逗号/分号都出现过（比如受理人筛选项里就是用分号拼接的），
// 都当成分隔符处理；人名本身不含这些符号，多认几种不会误伤（如"王婷婷(IT)"这种带括号的也不受影响）
function parseNameList(v: string | undefined): string[] {
  const t = emptyToNull(v);
  if (!t) return [];
  return Array.from(new Set(t.split(/[、,，;；]/).map((s) => s.trim()).filter(Boolean)));
}

// 当曲云列表里关注人这一列的表头文字：实际页面上确认是"关注人"，
// "关注人员"作为不同视图/版本可能的另一种叫法一并兼容
const WATCHER_HEADERS = ["关注人", "关注人员"];

function parseWatcher(row: ScrapedRow, existing?: Ticket): string[] {
  const header = WATCHER_HEADERS.find((h) => h in row);
  // 抓到的这一行里压根没有这一列（当曲云列表视图没展示该列，或表头文字跟上面几种都对不上）：
  // 保持工单原有关注人不动。不能当成"当曲云上没有关注人"直接清空——那是把"没抓到"
  // 误当成"确实为空"，会把已有数据洗掉
  if (!header) return existing?.watcher ?? [];
  return parseNameList(row[header]);
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
  const developer = parseNameList(row["开发人员"]);
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
    watcher: parseWatcher(row, existing),
    currentHandler: developer[0] ?? handler,
    itHandler: handler,
    developer,
    stage,
    status,
    devStatus,
    urgent: existing?.urgent ?? "",
    remark: existing?.remark ?? "",
    priority: emptyToNull(row["优先级"]),
    isReturned: existing?.isReturned ?? false,
    monthlyPlan: existing?.monthlyPlan ?? [],
    iterations,
    expectedTriageTime: emptyToNull(row["预计梳理完成"]),
    // "实际梳理完成"跟"预计梳理完成"一样是列表里的列（而不需要打开详情页的考核信息 tab才能看到），
    // 直接从抓取行里取；如果实际列表里这一列的表头文字不是这个，就会一直取不到值，
    // 需要对照真实页面表头文字核实调整
    actualTriageTime: emptyToNull(row["实际梳理完成"]) ?? existing?.actualTriageTime ?? null,
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
