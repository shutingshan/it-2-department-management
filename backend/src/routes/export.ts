import express, { Router } from "express";
import ExcelJS from "exceljs";
import { ZipArchive } from "archiver";
import dayjs from "dayjs";
import { store } from "../store";
import { applyFilters, parseQuery, scopeForActor, scopeForDefectActor } from "../filter";
import { canAccessDefects, canAccessRequirementAnalysis, isAdmin } from "../permissions";
import { hoursDeviation, Ticket } from "../types";
import { dedupe, stripCurrentIterationTag } from "../mapping";
import { computeRequirementModuleStats } from "../requirementModules";

const router = Router();

// 导出列与工单中心列表的列保持一致（顺序取列表的默认顺序：固定左侧列 + 中间可调序列），
// 列表上加了新列，这里要同步补上，否则导出的表格会缺字段
const COLUMNS: { header: string; key: string; width: number }[] = [
  { header: "编号", key: "code", width: 18 },
  { header: "TAPD", key: "tapdUrl", width: 30 },
  { header: "归属应用", key: "owningApp", width: 14 },
  { header: "需求模块", key: "module", width: 16 },
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
  { header: "需方期望月度", key: "expectedMonth", width: 14 },
  { header: "迭代", key: "iterations", width: 16 },
  { header: "预计梳理完成时间", key: "expectedTriageTime", width: 18 },
  { header: "实际梳理完成时间", key: "actualTriageTime", width: 18 },
  { header: "预计完成时间", key: "expectedCompleteTime", width: 14 },
  { header: "实际完成时间", key: "actualCompleteTime", width: 14 },
  { header: "预估工时", key: "estimatedHours", width: 10 },
  { header: "完成工时", key: "actualHours", width: 10 },
  { header: "工时偏差", key: "hoursDeviation", width: 10 },
  { header: "梳理工时", key: "triageHours", width: 10 },
  { header: "开发工时", key: "devHours", width: 10 },
  { header: "测试工时", key: "testHours", width: 10 },
  { header: "备注", key: "remark", width: 20 },
  { header: "提交时间", key: "submittedAt", width: 18 },
];

// 缺陷跟进的导出列：跟缺陷跟进列表的表头一一对应（列表上加/减列，这里要同步改），
// 跟上面工单中心那套完全独立——两个页面展示的字段本来就不是一回事
const DEFECT_COLUMNS: { header: string; key: string; width: number }[] = [
  { header: "编号", key: "code", width: 18 },
  { header: "归属应用", key: "owningApp", width: 16 },
  { header: "发起人", key: "requester", width: 12 },
  { header: "受理人", key: "itHandler", width: 12 },
  { header: "状态", key: "status", width: 10 },
  { header: "标题", key: "title", width: 32 },
  { header: "内容", key: "content", width: 48 },
  { header: "创建时间", key: "submittedAt", width: 18 },
  { header: "是否有测试用例", key: "hasTestCase", width: 14 },
  { header: "是否已补充测试用例", key: "testCaseSupplemented", width: 18 },
  { header: "是否做自动化测试", key: "hasAutomatedTest", width: 16 },
  { header: "自动化计划完成时间", key: "automationPlanCompleteTime", width: 18 },
  { header: "完成情况", key: "completionStatus", width: 12 },
  { header: "花费工时", key: "spentHours", width: 10 },
  { header: "备注", key: "remark", width: 24 },
];

// 单元格取值口径跟列表渲染保持一致：数组用「、」连接，空值统一写 "-"
const dash = (v: string | null | undefined) => (v && String(v).trim() ? v : "-");
const joinList = (v: string[]) => (v.length ? v.join("、") : "-");
// 三态字段：null=未填写，导出成 "-"，跟列表里显示的占位文案对齐
const yesNo = (v: boolean | null) => (v === null || v === undefined ? "-" : v ? "是" : "否");

function toDefectRow(t: Ticket) {
  return {
    code: t.code,
    owningApp: dash(t.owningApp),
    requester: dash(t.requester),
    itHandler: dash(t.itHandler),
    status: t.status,
    title: t.title,
    content: t.content,
    submittedAt: t.submittedAt,
    hasTestCase: yesNo(t.hasTestCase),
    testCaseSupplemented: yesNo(t.testCaseSupplemented),
    hasAutomatedTest: yesNo(t.hasAutomatedTest),
    automationPlanCompleteTime: dash(t.automationPlanCompleteTime),
    completionStatus: dash(t.completionStatus),
    // 工时是数字，0 是有效值不能被 dash 当成空；未填写（null）才写 "-"
    spentHours: t.spentHours ?? "-",
    remark: dash(t.remark),
  };
}

function toRow(t: Ticket) {
  return {
    code: t.code,
    tapdUrl: dash(t.tapdUrl),
    owningApp: dash(t.owningApp),
    requester: dash(t.requester),
    title: t.title,
    content: t.content,
    module: dash(t.module),
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
    expectedMonth: dash(t.expectedMonth),
    iterations: joinList(dedupe(t.iterations.map((i) => stripCurrentIterationTag(i.name)))),
    expectedTriageTime: dash(t.expectedTriageTime),
    actualTriageTime: dash(t.actualTriageTime),
    expectedCompleteTime: dash(t.expectedCompleteTime),
    actualCompleteTime: dash(t.actualCompleteTime),
    estimatedHours: t.estimatedHours,
    actualHours: t.actualHours,
    hoursDeviation: hoursDeviation(t),
    triageHours: t.triageHours ?? "-",
    devHours: t.devHours ?? "-",
    testHours: t.testHours ?? "-",
    remark: dash(t.remark),
    submittedAt: t.submittedAt,
  };
}

function buildSheet(workbook: ExcelJS.Workbook, name: string, tickets: Ticket[], isDefect = false) {
  const sheet = workbook.addWorksheet(name.slice(0, 28) || "工单");
  const cols = isDefect ? DEFECT_COLUMNS : COLUMNS;
  sheet.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  sheet.getRow(1).font = { bold: true };
  tickets.forEach((t) => sheet.addRow(isDefect ? toDefectRow(t) : toRow(t)));
}

function attachmentHeaders(res: import("express").Response, fileName: string, isZip: boolean) {
  res.setHeader("Content-Type", isZip ? "application/zip" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
}

// 「库内全量需求工单」认的分类值。当曲云的分类是固定几项（需求/数据处理/缺陷/咨询），
// 这里只取「需求」这一项
const REQUIREMENT_CATEGORY = "需求";

// 需求分析看板 · 模块明细的导出列
const REQUIREMENT_DETAIL_COLUMNS: { header: string; key: string; width: number }[] = [
  { header: "工单编码", key: "code", width: 18 },
  { header: "归属应用", key: "owningApp", width: 16 },
  { header: "需求模块", key: "module", width: 20 },
  { header: "状态", key: "status", width: 10 },
  { header: "期望完成时间", key: "expectedCompleteTime", width: 14 },
  { header: "实际完成时间", key: "actualCompleteTime", width: 14 },
  { header: "IT受理人", key: "itHandler", width: 12 },
  { header: "发起人", key: "requester", width: 12 },
  { header: "统计时间点", key: "timePoint", width: 14 },
  { header: "模块来源", key: "moduleSource", width: 12 },
];

// 需求分析看板的导出列，与页面表格一一对应
const REQUIREMENT_MODULE_COLUMNS: { header: string; key: string; width: number }[] = [
  { header: "需求模块", key: "module", width: 24 },
  { header: "需求条数", key: "count", width: 10 },
  { header: "最早时间点", key: "firstTime", width: 14 },
  { header: "最晚时间点", key: "lastTime", width: 14 },
  { header: "平均间隔（天）", key: "avgIntervalDays", width: 14 },
  { header: "频率", key: "frequency", width: 10 },
  { header: "模块来源", key: "moduleSource", width: 12 },
];

/**
 * 「库内全量需求工单」这一个导出里对需求模块的处理：值里带「/」时，去掉「/」及其之前的内容。
 * 当曲云上这个字段常写成「订单中心/支付模块」这种带上级前缀的形式，这里只要最后一级。
 *
 * 多级（A/B/C）按最后一个「/」切，取最末一级；同时兼容中文输入法下的全角「／」。
 * 切完为空（例如结尾就是「/」）时退回占位符，不要导出一个空单元格。
 * 只在这个导出模式生效，列表与其余导出模式仍是原值。
 */
function stripModulePrefix(v: string): string {
  if (!v) return v;
  const idx = Math.max(v.lastIndexOf("/"), v.lastIndexOf("／"));
  if (idx < 0) return v;
  return v.slice(idx + 1).trim() || "-";
}

/**
 * 导出工单。四种模式：
 * - scope=all              全量导出：当前筛选条件命中的全部工单，导成单个 xlsx
 * - scope=selected         导出所选：只导 ids 里勾选的工单，导成单个 xlsx
 * - scope=allRequirements  库内全量需求工单：见下方该分支的注释，口径跟前三种都不一样
 * - 不传 scope             按人分组导出（原有逻辑）：groupBy=requester/itHandler，每人一个文件打包成 zip
 *
 * 四种模式的表格列完全一致，都是工单中心列表的全部字段。
 */
router.post("/", async (req, res) => {
  const { groupBy, scope, view, ids, actor, actorRole, ...filters } = req.body as {
    groupBy?: string;
    scope?: string;
    view?: string;
    ids?: string[];
    actor?: string;
    actorRole?: string;
  } & Record<string, unknown>;

  // view=requirementModules：需求分析看板的导出。导的是聚合后的模块统计，
  // 列跟工单列表完全不同，也不受列表筛选影响，所以在最前面单独分流
  if (view === "requirementModules") {
    if (!canAccessRequirementAnalysis(actor)) {
      return res.status(403).json({ message: "无权限：该账号未被授权访问需求分析看板" });
    }
    const rawYear = (req.body as { year?: unknown }).year;
    const year =
      typeof rawYear === "number"
        ? rawYear
        : typeof rawYear === "string" && /^\d{4}$/.test(rawYear)
        ? Number(rawYear)
        : null;
    const stats = computeRequirementModuleStats(store.tickets, year);
    const scopeName = year ? `${year}年` : "整体";
    const stamp2 = dayjs().format("YYYYMMDD_HHmm");
    // 传了 module 就导这个模块的工单明细，否则导模块汇总表
    const targetModule = typeof (req.body as { module?: unknown }).module === "string"
      ? String((req.body as { module?: unknown }).module)
      : null;

    const workbook = new ExcelJS.Workbook();
    if (targetModule) {
      const row = stats.rows.find((r) => r.module === targetModule);
      if (!row || row.tickets.length === 0) {
        return res.status(400).json({ message: `当前范围内没有模块「${targetModule}」的工单明细可导出` });
      }
      const sheet = workbook.addWorksheet("需求明细");
      sheet.columns = REQUIREMENT_DETAIL_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
      sheet.getRow(1).font = { bold: true };
      row.tickets.forEach((d) =>
        sheet.addRow({
          ...d,
          expectedCompleteTime: dash(d.expectedCompleteTime),
          actualCompleteTime: dash(d.actualCompleteTime),
          moduleSource: d.fromOwningApp ? "归属应用" : "需求模块",
        })
      );
      attachmentHeaders(
        res,
        `IT二部需求明细_${targetModule}_${scopeName}_${row.tickets.length}条_${stamp2}.xlsx`,
        false
      );
      const detailBuffer = await workbook.xlsx.writeBuffer();
      return res.end(Buffer.from(detailBuffer));
    }

    if (stats.rows.length === 0) {
      return res.status(400).json({ message: "当前范围内没有可导出的需求模块数据" });
    }
    const sheet = workbook.addWorksheet("需求模块分析");
    sheet.columns = REQUIREMENT_MODULE_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    sheet.getRow(1).font = { bold: true };
    stats.rows.forEach((r) =>
      sheet.addRow({
        ...r,
        avgIntervalDays: r.avgIntervalDays ?? "-",
        moduleSource: r.fromOwningApp ? "归属应用" : "需求模块",
      })
    );
    attachmentHeaders(
      res,
      `IT二部需求模块分析_${scopeName}_${stats.rows.length}个模块_${stamp2}.xlsx`,
      false
    );
    const buffer = await workbook.xlsx.writeBuffer();
    return res.end(Buffer.from(buffer));
  }

  // view=defect：缺陷跟进页的导出，分类范围与可见范围都换成缺陷那套，导出列也换成缺陷列表的列
  const isDefect = view === "defect";

  // 未授权时明确报权限错误。否则会走到下面"结果为空"的分支，
  // 提示成"当前筛选条件下没有可导出的数据"，让人以为是筛选问题
  if (isDefect && !canAccessDefects(actor)) {
    return res.status(403).json({ message: "无权限：该账号未被授权访问缺陷跟进" });
  }

  // 导出范围必须跟列表一致：IT受理人只导自己负责的、需求方只导跟自己相关的，
  // 否则"全量导出"会把这些角色在列表里根本看不到的工单一并导出去
  // 导出范围跟列表保持一致：先按分类显示范围收敛，再按登录身份圈定
  const visible = isDefect
    ? scopeForDefectActor(store.defectVisibleTickets, canAccessDefects(actor))
    : scopeForActor(store.visibleTickets, actor, actorRole);
  const stamp = dayjs().format("YYYYMMDD_HHmm");
  const docName = isDefect ? "IT二部缺陷数据" : "IT二部工单数据";

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
    buildSheet(workbook, docName, selected, isDefect);
    attachmentHeaders(res, `${docName}_所选${selected.length}条_${stamp}.xlsx`, false);
    const buffer = await workbook.xlsx.writeBuffer();
    return res.end(Buffer.from(buffer));
  }

  /**
   * 库内全量需求工单：刻意绕开工单中心的显示范围配置（分类保留 / 归属应用排除 / 状态排除）
   * 与列表上的筛选条件，直接从整库取分类为「需求」的工单——这个入口的意义就是"拿全"，
   * 走 visibleTickets 的话会被那几项配置削掉一部分，跟"库内全量"这个名字不符。
   *
   * 正因为绕开了这些收敛，这个入口仅开放给管理员。
   */
  if (scope === "allRequirements") {
    // 仅管理员：这个模式绕开了显示范围配置，导的是整库数据，不能开放给其他角色。
    // 判断走账号记录（permissions.isAdmin），不认前端传的 actorRole
    if (!isAdmin(actor)) {
      return res.status(403).json({ message: "权限不足：仅管理员可导出库内全量需求工单" });
    }
    // 已经限定管理员，直接取整库即可，无需再套 scopeForActor（管理员本就不受其限制，
    // 再套一层反而会被前端传来的 actorRole 影响，口径变得不确定）
    const inStore = store.tickets
      .filter((t) => t.category?.trim() === REQUIREMENT_CATEGORY)
      // 只改导出用的副本，不动库里的原值
      .map((t) => ({ ...t, module: stripModulePrefix(t.module) }));
    if (inStore.length === 0) {
      return res.status(400).json({ message: `库内没有分类为「${REQUIREMENT_CATEGORY}」的工单可导出` });
    }
    const workbook = new ExcelJS.Workbook();
    buildSheet(workbook, `${REQUIREMENT_CATEGORY}工单`, inStore);
    attachmentHeaders(res, `IT二部工单数据_库内全量${REQUIREMENT_CATEGORY}_${inStore.length}条_${stamp}.xlsx`, false);
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
    buildSheet(workbook, docName, filtered, isDefect);
    attachmentHeaders(res, `${docName}_全量${filtered.length}条_${stamp}.xlsx`, false);
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

  attachmentHeaders(res, `${docName}_${stamp}.zip`, true);

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on("error", (_err: Error) => {
    res.status(500).end();
  });
  archive.pipe(res);

  for (const [person, tickets] of groups) {
    const fileName = `${docName}-${person}`;
    const workbook = new ExcelJS.Workbook();
    buildSheet(workbook, fileName, tickets, isDefect);
    const buffer = await workbook.xlsx.writeBuffer();
    archive.append(Buffer.from(buffer), { name: `${fileName}.xlsx` });
  }

  await archive.finalize();
});

export default router;

// ---------------------------------------------------------------------------
// 导入匹配状态：上传一份带工单编号的表格，按编号回填「状态」列后原样导回
// ---------------------------------------------------------------------------

// 上传文件里工单编号列的可能表头。不同人导出的表格叫法不一，都认一遍，
// 认不出来时直接报错并把这几个名字告诉使用者，而不是默默匹配 0 条
const CODE_HEADERS = ["工单编号", "工单编码", "编号", "工单号"];
const STATUS_HEADER = "状态";
const UNMATCHED_TEXT = "未匹配";

/** 表头单元格的文本。ExcelJS 里富文本/公式单元格的 value 不是字符串，统一取纯文本 */
function cellText(cell: ExcelJS.Cell | undefined): string {
  if (!cell) return "";
  const v = cell.value as unknown;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    // 富文本 { richText: [...] } 与公式 { result: ... } 两种常见形态
    const rich = (v as { richText?: { text: string }[] }).richText;
    if (rich) return rich.map((r) => r.text).join("").trim();
    const result = (v as { result?: unknown }).result;
    if (result !== undefined && result !== null) return String(result).trim();
    if (v instanceof Date) return "";
    return "";
  }
  return String(v).trim();
}

/**
 * 上传一份表格，按「工单编号」匹配库里的工单，把当前状态回填到「状态」列，再把整张表导回。
 *
 * 刻意保留上传文件的原有内容与列顺序，只动状态那一列：使用者拿回去的还是自己那张表，
 * 只是多了状态，不需要再做一次对齐。原文件没有状态列时在最后新增一列。
 *
 * 匹配范围跟列表一致（scopeForActor）：IT受理人只匹配自己受理的、需求方只匹配跟自己相关的，
 * 匹配不到的填「未匹配」，不会静默留空让人以为是漏填。
 */
router.post(
  "/match-status",
  express.raw({
    type: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "application/octet-stream",
    ],
    limit: "20mb",
  }),
  async (req, res) => {
    const { actor, actorRole } = req.query as { actor?: string; actorRole?: string };
    const buffer = req.body as Buffer;
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
      return res.status(400).json({ message: "没有读到上传的文件，请重新选择 Excel 文件" });
    }

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    } catch {
      return res.status(400).json({ message: "文件解析失败，请确认上传的是 .xlsx 格式的 Excel 文件" });
    }

    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount < 2) {
      return res.status(400).json({ message: "表格里没有数据行（第一行为表头，第二行起为数据）" });
    }

    // 表头固定认第一行：导出的表格都是这个形态，多加一层"找表头"的猜测反而不可控
    const headerRow = sheet.getRow(1);
    let codeCol = 0;
    let statusCol = 0;
    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const text = cellText(cell);
      if (!codeCol && CODE_HEADERS.includes(text)) codeCol = colNumber;
      if (!statusCol && text === STATUS_HEADER) statusCol = colNumber;
    });

    if (!codeCol) {
      return res.status(400).json({
        message: `表格第一行没有找到工单编号列，表头需要是以下之一：${CODE_HEADERS.join("、")}`,
      });
    }
    // 没有状态列就在最后补一列，不覆盖使用者原有的任何列
    if (!statusCol) {
      statusCol = sheet.columnCount + 1;
      headerRow.getCell(statusCol).value = STATUS_HEADER;
      headerRow.getCell(statusCol).font = { bold: true };
      sheet.getColumn(statusCol).width = 12;
    }

    // 匹配范围跟列表一致；编号去空格后比对，避免复制粘贴带来的首尾空格匹配不上
    const scoped = scopeForActor(store.tickets, actor, actorRole);
    const statusByCode = new Map(scoped.map((t) => [t.code.trim(), t.status]));

    let matched = 0;
    let unmatched = 0;
    for (let i = 2; i <= sheet.rowCount; i += 1) {
      const row = sheet.getRow(i);
      const code = cellText(row.getCell(codeCol));
      if (!code) continue; // 空行/小计行之类，跳过不计数
      const status = statusByCode.get(code);
      row.getCell(statusCol).value = status ?? UNMATCHED_TEXT;
      if (status) matched += 1;
      else unmatched += 1;
    }

    if (matched === 0 && unmatched === 0) {
      return res.status(400).json({ message: "表格里没有读到任何工单编号，请检查编号列是否为空" });
    }

    // 匹配结果写进文件名：下载后不打开也能一眼看到匹配情况
    attachmentHeaders(
      res,
      `工单状态匹配结果_匹配${matched}条_未匹配${unmatched}条_${dayjs().format("YYYYMMDD_HHmm")}.xlsx`,
      false
    );
    res.setHeader("X-Match-Total", String(matched + unmatched));
    res.setHeader("X-Match-Matched", String(matched));
    res.setHeader("X-Match-Unmatched", String(unmatched));
    const out = await workbook.xlsx.writeBuffer();
    return res.end(Buffer.from(out));
  }
);
