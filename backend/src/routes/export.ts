import { Router } from "express";
import ExcelJS from "exceljs";
import { ZipArchive } from "archiver";
import dayjs from "dayjs";
import { store } from "../store";
import { applyFilters, parseQuery, scopeForActor } from "../filter";
import { hoursDeviation, Ticket } from "../types";
import { dedupe, stripCurrentIterationTag } from "../mapping";

const router = Router();

// 导出列与工单中心列表的列保持一致（顺序取列表的默认顺序：固定左侧列 + 中间可调序列），
// 列表上加了新列，这里要同步补上，否则导出的表格会缺字段
const COLUMNS: { header: string; key: string; width: number }[] = [
  { header: "编号", key: "code", width: 18 },
  { header: "TAPD", key: "tapdUrl", width: 30 },
  { header: "归属应用", key: "owningApp", width: 14 },
  { header: "发起人", key: "requester", width: 12 },
  { header: "标题", key: "title", width: 32 },
  { header: "内容", key: "content", width: 40 },
  { header: "分类", key: "category", width: 12 },
  { header: "发起部门", key: "requesterDept", width: 14 },
  { header: "关注人", key: "watcher", width: 16 },
  { header: "当前处理人", key: "currentHandler", width: 16 },
  { header: "IT受理人", key: "itHandler", width: 12 },
  { header: "开发人员", key: "developer", width: 16 },
  { header: "工单阶段", key: "stage", width: 12 },
  { header: "状态", key: "status", width: 10 },
  { header: "TAPD状态", key: "devStatus", width: 12 },
  { header: "紧急", key: "urgent", width: 8 },
  { header: "优先级", key: "priority", width: 10 },
  { header: "月度计划", key: "monthlyPlan", width: 14 },
  { header: "迭代", key: "iterations", width: 16 },
  { header: "预计梳理完成时间", key: "expectedTriageTime", width: 18 },
  { header: "实际梳理完成时间", key: "actualTriageTime", width: 18 },
  { header: "预计完成时间", key: "expectedCompleteTime", width: 14 },
  { header: "实际完成时间", key: "actualCompleteTime", width: 14 },
  { header: "预估工时", key: "estimatedHours", width: 10 },
  { header: "完成工时", key: "actualHours", width: 10 },
  { header: "工时偏差", key: "hoursDeviation", width: 10 },
  { header: "备注", key: "remark", width: 20 },
  { header: "提交时间", key: "submittedAt", width: 18 },
];

// 单元格取值口径跟列表渲染保持一致：数组用「、」连接，空值统一写 "-"
const dash = (v: string | null | undefined) => (v && String(v).trim() ? v : "-");
const joinList = (v: string[]) => (v.length ? v.join("、") : "-");

function toRow(t: Ticket) {
  return {
    code: t.code,
    tapdUrl: dash(t.tapdUrl),
    owningApp: dash(t.owningApp),
    requester: dash(t.requester),
    title: t.title,
    content: t.content,
    category: dash(t.category),
    requesterDept: dash(t.requesterDept),
    watcher: joinList(t.watcher),
    currentHandler: dash(t.currentHandler),
    itHandler: dash(t.itHandler),
    developer: joinList(t.developer),
    stage: t.stage,
    status: t.status,
    devStatus: dash(t.devStatus),
    urgent: dash(t.urgent),
    priority: dash(t.priority),
    monthlyPlan: joinList(t.monthlyPlan),
    iterations: joinList(dedupe(t.iterations.map((i) => stripCurrentIterationTag(i.name)))),
    expectedTriageTime: dash(t.expectedTriageTime),
    actualTriageTime: dash(t.actualTriageTime),
    expectedCompleteTime: dash(t.expectedCompleteTime),
    actualCompleteTime: dash(t.actualCompleteTime),
    estimatedHours: t.estimatedHours,
    actualHours: t.actualHours,
    hoursDeviation: hoursDeviation(t),
    remark: dash(t.remark),
    submittedAt: t.submittedAt,
  };
}

function buildSheet(workbook: ExcelJS.Workbook, name: string, tickets: Ticket[]) {
  const sheet = workbook.addWorksheet(name.slice(0, 28) || "工单");
  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  sheet.getRow(1).font = { bold: true };
  tickets.forEach((t) => sheet.addRow(toRow(t)));
}

function attachmentHeaders(res: import("express").Response, fileName: string, isZip: boolean) {
  res.setHeader("Content-Type", isZip ? "application/zip" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
}

/**
 * 导出工单。三种模式：
 * - scope=all       全量导出：当前筛选条件命中的全部工单，导成单个 xlsx
 * - scope=selected  导出所选：只导 ids 里勾选的工单，导成单个 xlsx
 * - 不传 scope      按人分组导出（原有逻辑）：groupBy=requester/itHandler，每人一个文件打包成 zip
 *
 * 三种模式的表格列完全一致，都是工单中心列表的全部字段。
 */
router.post("/", async (req, res) => {
  const { groupBy, scope, ids, actor, actorRole, ...filters } = req.body as {
    groupBy?: string;
    scope?: string;
    ids?: string[];
    actor?: string;
    actorRole?: string;
  } & Record<string, unknown>;

  // 导出范围必须跟列表一致：IT受理人只导自己负责的、需求方只导跟自己相关的，
  // 否则"全量导出"会把这些角色在列表里根本看不到的工单一并导出去
  // 导出范围跟列表保持一致：先按分类显示范围收敛，再按登录身份圈定
  const visible = scopeForActor(store.visibleTickets, actor, actorRole);
  const stamp = dayjs().format("YYYYMMDD_HHmm");

  if (scope === "selected") {
    if (!ids?.length) {
      return res.status(400).json({ message: "请先在列表中勾选要导出的工单" });
    }
    const target = new Set(ids);
    const selected = visible.filter((t) => target.has(t.id));
    if (selected.length === 0) {
      return res.status(400).json({ message: "勾选的工单都不存在或无权限导出" });
    }
    const workbook = new ExcelJS.Workbook();
    buildSheet(workbook, "IT二部工单数据", selected);
    attachmentHeaders(res, `IT二部工单数据_所选${selected.length}条_${stamp}.xlsx`, false);
    const buffer = await workbook.xlsx.writeBuffer();
    return res.end(Buffer.from(buffer));
  }

  const q = parseQuery(filters);
  const filtered = applyFilters(visible, q);

  if (filtered.length === 0) {
    return res.status(400).json({ message: "当前筛选条件下没有可导出的数据" });
  }

  if (scope === "all") {
    const workbook = new ExcelJS.Workbook();
    buildSheet(workbook, "IT二部工单数据", filtered);
    attachmentHeaders(res, `IT二部工单数据_全量${filtered.length}条_${stamp}.xlsx`, false);
    const buffer = await workbook.xlsx.writeBuffer();
    return res.end(Buffer.from(buffer));
  }

  // 分组维度导出：requester=按发起人（默认，兼容旧调用），itHandler=按IT受理人；
  // 每个人一个文件，命名 IT二部工单数据-{人名}
  const groupField: "requester" | "itHandler" = groupBy === "itHandler" ? "itHandler" : "requester";
  const groups = new Map<string, Ticket[]>();
  filtered.forEach((t) => {
    const key = t[groupField] || "未分配";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  });

  attachmentHeaders(res, `IT二部工单数据_${stamp}.zip`, true);

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on("error", (_err: Error) => {
    res.status(500).end();
  });
  archive.pipe(res);

  for (const [person, tickets] of groups) {
    const fileName = `IT二部工单数据-${person}`;
    const workbook = new ExcelJS.Workbook();
    buildSheet(workbook, fileName, tickets);
    const buffer = await workbook.xlsx.writeBuffer();
    archive.append(Buffer.from(buffer), { name: `${fileName}.xlsx` });
  }

  await archive.finalize();
});

export default router;
