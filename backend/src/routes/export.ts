import { Router } from "express";
import ExcelJS from "exceljs";
import { ZipArchive } from "archiver";
import dayjs from "dayjs";
import { store } from "../store";
import { applyFilters, parseQuery } from "../filter";
import { hoursDeviation, Ticket } from "../types";

const router = Router();

const COLUMNS: { header: string; key: keyof Ticket | "hoursDeviation"; width: number }[] = [
  { header: "编号", key: "code", width: 18 },
  { header: "分类", key: "category", width: 12 },
  { header: "归属应用", key: "owningApp", width: 14 },
  { header: "标题", key: "title", width: 32 },
  { header: "发起人", key: "requester", width: 12 },
  { header: "IT受理人", key: "itHandler", width: 12 },
  { header: "当前处理人", key: "currentHandler", width: 16 },
  { header: "工单阶段", key: "stage", width: 12 },
  { header: "状态", key: "status", width: 10 },
  { header: "紧急", key: "urgent", width: 8 },
  { header: "预估工时", key: "estimatedHours", width: 10 },
  { header: "实际工时", key: "actualHours", width: 10 },
  { header: "工时偏差", key: "hoursDeviation", width: 10 },
  { header: "提交时间", key: "submittedAt", width: 18 },
  { header: "预计完成时间", key: "expectedCompleteTime", width: 14 },
  { header: "实际完成时间", key: "actualCompleteTime", width: 14 },
];

function buildSheet(workbook: ExcelJS.Workbook, name: string, tickets: Ticket[]) {
  const sheet = workbook.addWorksheet(name.slice(0, 28) || "工单");
  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  sheet.getRow(1).font = { bold: true };
  tickets.forEach((t) => {
    sheet.addRow({
      ...t,
      urgent: t.urgent ? "是" : "否",
      hoursDeviation: hoursDeviation(t),
    });
  });
}

router.post("/", async (req, res) => {
  const { groupBy, ...query } = req.body as { groupBy?: "requester" | "itHandler" } & Record<string, unknown>;
  const q = parseQuery(query);
  const filtered = applyFilters(store.tickets, q);

  if (filtered.length === 0) {
    return res.status(400).json({ message: "当前筛选条件下没有可导出的数据" });
  }

  const groups = new Map<string, Ticket[]>();
  if (groupBy === "requester" || groupBy === "itHandler") {
    filtered.forEach((t) => {
      const key = groupBy === "requester" ? t.requester : t.itHandler;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    });
  } else {
    groups.set("工单导出", filtered);
  }

  const zipName = `工单导出_${dayjs().format("YYYYMMDD_HHmm")}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(zipName)}"`);

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on("error", (_err: Error) => {
    res.status(500).end();
  });
  archive.pipe(res);

  for (const [name, tickets] of groups) {
    const workbook = new ExcelJS.Workbook();
    buildSheet(workbook, name, tickets);
    const buffer = await workbook.xlsx.writeBuffer();
    archive.append(Buffer.from(buffer), { name: `${name}.xlsx` });
  }

  await archive.finalize();
});

export default router;
