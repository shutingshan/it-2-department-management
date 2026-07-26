import { Router } from "express";
import ExcelJS from "exceljs";
import { ZipArchive } from "archiver";
import dayjs from "dayjs";
import { store } from "../store";
import { applyFilters, parseQuery } from "../filter";
import { Ticket } from "../types";

const router = Router();

const COLUMNS: { header: string; key: string; width: number }[] = [
  { header: "工单编号", key: "code", width: 18 },
  { header: "归属应用", key: "owningApp", width: 14 },
  { header: "标题", key: "title", width: 32 },
  { header: "内容", key: "content", width: 40 },
  { header: "优先级", key: "priority", width: 10 },
  { header: "紧急", key: "urgent", width: 8 },
  { header: "工单阶段", key: "stage", width: 12 },
  { header: "迭代", key: "iterations", width: 16 },
  { header: "月度计划", key: "monthlyPlan", width: 14 },
  { header: "预计完成时间", key: "expectedCompleteTime", width: 14 },
  { header: "提交时间", key: "submittedAt", width: 18 },
  { header: "发起人", key: "requester", width: 12 },
  { header: "关注人", key: "watcher", width: 16 },
  { header: "IT受理人", key: "itHandler", width: 12 },
  { header: "tapd地址", key: "tapdUrl", width: 30 },
];

function buildSheet(workbook: ExcelJS.Workbook, name: string, tickets: Ticket[]) {
  const sheet = workbook.addWorksheet(name.slice(0, 28) || "工单");
  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  sheet.getRow(1).font = { bold: true };
  tickets.forEach((t) => {
    sheet.addRow({
      code: t.code,
      owningApp: t.owningApp,
      title: t.title,
      content: t.content,
      priority: t.priority ?? "-",
      urgent: t.urgent ? "是" : "否",
      stage: t.stage,
      iterations: t.iterations.map((i) => i.name).join("、") || "-",
      monthlyPlan: t.monthlyPlan.join("、") || "-",
      expectedCompleteTime: t.expectedCompleteTime ?? "-",
      submittedAt: t.submittedAt,
      requester: t.requester,
      watcher: t.watcher.join("、") || "-",
      itHandler: t.itHandler,
      tapdUrl: t.tapdUrl ?? "-",
    });
  });
}

// 按发起人维度导出：每个发起人一个文件，命名 IT二部工单数据-{发起人}
router.post("/", async (req, res) => {
  const q = parseQuery(req.body as Record<string, unknown>);
  const filtered = applyFilters(store.tickets, q);

  if (filtered.length === 0) {
    return res.status(400).json({ message: "当前筛选条件下没有可导出的数据" });
  }

  const groups = new Map<string, Ticket[]>();
  filtered.forEach((t) => {
    if (!groups.has(t.requester)) groups.set(t.requester, []);
    groups.get(t.requester)!.push(t);
  });

  const zipName = `IT二部工单数据_${dayjs().format("YYYYMMDD_HHmm")}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(zipName)}"`);

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on("error", (_err: Error) => {
    res.status(500).end();
  });
  archive.pipe(res);

  for (const [requester, tickets] of groups) {
    const fileName = `IT二部工单数据-${requester}`;
    const workbook = new ExcelJS.Workbook();
    buildSheet(workbook, fileName, tickets);
    const buffer = await workbook.xlsx.writeBuffer();
    archive.append(Buffer.from(buffer), { name: `${fileName}.xlsx` });
  }

  await archive.finalize();
});

export default router;
