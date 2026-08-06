import { Router } from "express";
import dayjs from "dayjs";
import { store } from "../store";
import { Ticket } from "../types";
import { getRootDeptId, getDeptName, getTopLevelDepartments, getChildDeptIds } from "../deptUtils";
import { hoursDeviation } from "../types";

const router = Router();

function inYear(dateStr: string | null, year: number | null): boolean {
  if (year === null) return true;
  if (!dateStr) return false;
  return dayjs(dateStr).year() === year;
}

// "各受理人过去三年每月接收/完成数量对比"图表里"全部数据"选项的键名，
// 代表不筛选具体受理人、汇总部门整体数据；前端下拉框的 value 需要跟这个字符串保持一致
export const ALL_HANDLERS_KEY = "__all__";

// ---------- 首页统计 ----------
router.get("/home", (req, res) => {
  const yearParam = String(req.query.year ?? "2026");
  const year = yearParam === "all" ? null : Number(yearParam);
  // 看板口径与工单中心一致：先按「分类显示范围」配置收敛
  const tickets = store.visibleTickets;

  const completed = tickets.filter(
    (t) => (t.status === "已完成" || t.status === "已解决") && inYear(t.actualCompleteTime, year)
  );
  const closed = tickets.filter((t) => t.status === "关闭" && inYear(t.closedAt, year));
  const incomplete = tickets.filter(
    (t) => inYear(t.submittedAt, year) && t.stage !== "已完成" && t.stage !== "关闭"
  );
  const submittedInYear = tickets.filter((t) => inYear(t.submittedAt, year));

  const byHandler: Record<string, number> = {};
  submittedInYear.forEach((t) => {
    byHandler[t.itHandler] = (byHandler[t.itHandler] ?? 0) + 1;
  });
  const handlerRatio = Object.entries(byHandler).map(([name, value]) => ({ name, value }));

  const stageRatio = Object.entries(
    submittedInYear.reduce<Record<string, number>>((acc, t) => {
      acc[t.stage] = (acc[t.stage] ?? 0) + 1;
      return acc;
    }, {})
  ).map(([stage, value]) => ({ stage, value }));

  const owningAppDrilldown = (stage: string) =>
    Object.entries(
      submittedInYear
        .filter((t) => t.stage === stage)
        .reduce<Record<string, number>>((acc, t) => {
          acc[t.owningApp] = (acc[t.owningApp] ?? 0) + 1;
          return acc;
        }, {})
    ).map(([owningApp, value]) => ({ owningApp, value }));

  const handlerDeptDrilldown = (handler: string) => {
    const rows = submittedInYear.filter((t) => t.itHandler === handler);
    const byRoot: Record<string, number> = {};
    rows.forEach((t) => {
      const root = getDeptName(getRootDeptId(t.requesterDept));
      byRoot[root] = (byRoot[root] ?? 0) + 1;
    });
    return Object.entries(byRoot).map(([dept, value]) => ({ dept, value }));
  };

  // 各受理人过去三年每月接收/完成数量对比
  const years = [2024, 2025, 2026];
  // handler 为 null 表示不筛选具体受理人，统计部门整体（全部受理人汇总）的接收/完成数量
  const monthlySeries = (handler: string | null) =>
    years.flatMap((y) =>
      Array.from({ length: 12 }, (_, m) => {
        const matchHandler = (t: Ticket) => handler === null || t.itHandler === handler;
        const received = tickets.filter(
          (t) => matchHandler(t) && dayjs(t.submittedAt).year() === y && dayjs(t.submittedAt).month() === m
        ).length;
        const done = tickets.filter(
          (t) =>
            matchHandler(t) &&
            t.actualCompleteTime &&
            dayjs(t.actualCompleteTime).year() === y &&
            dayjs(t.actualCompleteTime).month() === m
        ).length;
        return { year: y, month: m + 1, received, completed: done };
      })
    );
  // "全部" 汇总项固定排在最前面，键名用 ALL_HANDLERS_KEY（不会跟真实受理人姓名撞车）
  const monthlyTrend = [
    { handler: ALL_HANDLERS_KEY, series: monthlySeries(null) },
    ...Object.keys(byHandler).map((handler) => ({ handler, series: monthlySeries(handler) })),
  ];

  // 梳理及完成进度：默认当前年当前月
  const progressYear = Number(req.query.progressYear ?? 2026);
  const progressMonth = Number(req.query.progressMonth ?? 7);
  const triageCount = tickets.filter(
    (t) =>
      t.actualTriageTime &&
      dayjs(t.actualTriageTime).year() === progressYear &&
      dayjs(t.actualTriageTime).month() + 1 === progressMonth
  ).length;
  const completeCount = tickets.filter(
    (t) =>
      t.actualCompleteTime &&
      dayjs(t.actualCompleteTime).year() === progressYear &&
      dayjs(t.actualCompleteTime).month() + 1 === progressMonth
  ).length;

  res.json({
    cards: {
      handlerTotal: submittedInYear.length,
      completed: completed.length,
      closed: closed.length,
      incomplete: incomplete.length,
    },
    handlerRatio,
    stageRatio,
    owningAppDrilldown: stageRatio.map((s) => ({ stage: s.stage, apps: owningAppDrilldown(s.stage) })),
    handlerDeptDrilldown: handlerRatio.map((h) => ({ handler: h.name, depts: handlerDeptDrilldown(h.name) })),
    monthlyTrend,
    progress: { year: progressYear, month: progressMonth, triageCount, completeCount },
  });
});

// ---------- 开发工时统计 ----------

// 工时统计的最小单元：没有子需求的工单，统计单元就是工单自己；有子需求的工单，
// 每条子需求各自算一个独立的统计单元（各自的开发人员/工时/迭代都可能不同，不能只看父需求）。
// 是否"已完成"、提交时间等生命周期字段子需求没有自己的一份，统一沿用父需求的
interface DevHourUnit {
  code: string; // 展示用编号：无子需求就是工单编号，有子需求是"父编号-子需求编号"
  title: string;
  content: string;
  owningApp: string;
  requester: string;
  requesterDept: string;
  tapdUrl: string | null;
  iterationNames: string[];
  developers: string[];
  estimatedHours: number;
  actualHours: number;
  parentStage: Ticket["stage"];
  parentStatus: Ticket["status"];
  parentActualCompleteTime: string | null;
  parentSubmittedAt: string;
}

function splitNames(v: string): string[] {
  return v
    .split(/[、,，;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function expandToDevHourUnits(t: Ticket): DevHourUnit[] {
  const shared = {
    content: t.content, // 子需求没有自己独立的内容字段，统一沿用父需求的
    owningApp: t.owningApp,
    requester: t.requester,
    requesterDept: t.requesterDept,
    parentStage: t.stage,
    parentStatus: t.status,
    parentActualCompleteTime: t.actualCompleteTime,
    parentSubmittedAt: t.submittedAt,
  };
  if (t.subTickets.length === 0) {
    return [
      {
        ...shared,
        code: t.code,
        title: t.title,
        tapdUrl: t.tapdUrl,
        iterationNames: t.iterations.map((i) => i.name),
        developers: t.developer.length ? t.developer : ["未分配"],
        estimatedHours: t.estimatedHours,
        actualHours: t.actualHours,
      },
    ];
  }
  return t.subTickets.map((s) => ({
    ...shared,
    code: `${t.code}-${s.code}`,
    title: s.title || t.title,
    tapdUrl: s.tapdUrl ?? t.tapdUrl,
    iterationNames: s.iteration ? [s.iteration.name] : [],
    developers: s.developer.trim() ? splitNames(s.developer) : ["未分配"],
    estimatedHours: s.estimatedHours,
    actualHours: s.actualHours,
  }));
}

router.get("/dev-hours", (req, res) => {
  // 看板口径与工单中心一致：先按「分类显示范围」配置收敛
  const tickets = store.visibleTickets;
  const units = tickets.flatMap(expandToDevHourUnits);

  // 排序用的日期键：优先用迭代自己的起始日期（API模式才有真实值）；浏览器模式抓不到
  // 起止日期，start/end 永远是空字符串，这时候改成从迭代名称里解析形如"260810~260814"
  // 开头的6位数字（年月日）当排序键，解析不出来再退回按名称本身排序，保证倒序排列有意义
  function iterationSortKey(it: { name: string; start: string }): string {
    if (it.start) return it.start;
    const m = it.name.match(/^(\d{6})/);
    return m ? m[1] : it.name;
  }
  const allIterations = Array.from(
    new Map(tickets.flatMap((t) => t.iterations).map((it) => [it.name, it])).values()
  ).sort((a, b) => (iterationSortKey(a) < iterationSortKey(b) ? 1 : -1)); // 倒序，新的排前面

  const today = dayjs("2026-07-24");
  let current = allIterations.find((it) => !today.isBefore(it.start) && !today.isAfter(it.end));
  if (!current) {
    // 回退到当前日期之前最近的迭代
    current = allIterations.find((it) => dayjs(it.end).isBefore(today));
  }
  // 迭代筛选支持多选 + "全部迭代"：不传 iterations 参数（或传空）就是"全部迭代"，
  // 不按任何迭代过滤；首次进入页面时前端会带上"当前迭代"作为默认选中项
  const requestedIterations = (
    Array.isArray(req.query.iterations)
      ? (req.query.iterations as unknown[]).map(String)
      : req.query.iterations
      ? String(req.query.iterations).split(",")
      : []
  ).filter(Boolean);

  const iterationUnits = requestedIterations.length
    ? units.filter((u) => u.iterationNames.some((n) => requestedIterations.includes(n)))
    : units;

  const iterationSummaryMap: Record<string, { ticketCount: number; estimatedHours: number; actualHours: number }> = {};
  iterationUnits.forEach((u) => {
    u.developers.forEach((dev) => {
      if (!iterationSummaryMap[dev]) iterationSummaryMap[dev] = { ticketCount: 0, estimatedHours: 0, actualHours: 0 };
      iterationSummaryMap[dev].ticketCount += 1;
      iterationSummaryMap[dev].estimatedHours += u.estimatedHours;
      iterationSummaryMap[dev].actualHours += u.actualHours;
    });
  });
  const iterationSummary = Object.entries(iterationSummaryMap).map(([developer, v]) => ({
    developer,
    ticketCount: v.ticketCount,
    estimatedHours: Number(v.estimatedHours.toFixed(1)),
    actualHours: Number(v.actualHours.toFixed(1)),
    diffHours: Number((v.actualHours - v.estimatedHours).toFixed(1)),
  }));

  // 迭代工单列表：有子需求的工单在这里会拆成多行，一行对应一个统计单元
  const iterationTickets = iterationUnits.map((u) => ({
    code: u.code,
    tapdUrl: u.tapdUrl,
    owningApp: u.owningApp,
    requester: u.requester,
    title: u.title,
    content: u.content,
    developer: u.developers.join("、"),
    iteration: u.iterationNames.join("、"),
    estimatedHours: u.estimatedHours,
    actualHours: u.actualHours,
    hoursDeviation: hoursDeviation(u),
  }));

  // 每个开发每年完成的统计单元数、预估/实际总工时、差异工时
  const year = Number(req.query.year ?? 2026);
  const annualUnits = units.filter(
    (u) => (u.parentStatus === "已完成" || u.parentStatus === "已解决") && inYear(u.parentActualCompleteTime, year)
  );
  const annualMap: Record<string, { completedCount: number; estimatedHours: number; actualHours: number }> = {};
  annualUnits.forEach((u) => {
    u.developers.forEach((dev) => {
      if (!annualMap[dev]) annualMap[dev] = { completedCount: 0, estimatedHours: 0, actualHours: 0 };
      annualMap[dev].completedCount += 1;
      annualMap[dev].estimatedHours += u.estimatedHours;
      annualMap[dev].actualHours += u.actualHours;
    });
  });
  const annualSummary = Object.entries(annualMap).map(([developer, v]) => ({
    developer,
    completedCount: v.completedCount,
    estimatedHours: Number(v.estimatedHours.toFixed(1)),
    actualHours: Number(v.actualHours.toFixed(1)),
    diffHours: Number((v.actualHours - v.estimatedHours).toFixed(1)),
  }));

  // 过去几年整体开发工时花费情况（已完成/已解决的统计单元，按年汇总预估/实际工时）
  const years = [2024, 2025, 2026];
  const yoyTrend = years.map((y) => {
    const done = units.filter(
      (u) => (u.parentStatus === "已完成" || u.parentStatus === "已解决") && inYear(u.parentActualCompleteTime, y)
    );
    return {
      year: y,
      estimatedHours: Number(done.reduce((s, u) => s + u.estimatedHours, 0).toFixed(1)),
      actualHours: Number(done.reduce((s, u) => s + u.actualHours, 0).toFixed(1)),
    };
  });

  // 各部门开发工时花费情况：按发起部门（requesterDept）归到顶级部门口径，
  // 筛选口径（按提交年份圈定范围、已完成/关闭算已花费实际工时、其余算预估待花费工时）
  // 跟已有的"部门统计"页面保持一致，只是这里的工时改用子需求感知后的统计单元
  const topDepts = getTopLevelDepartments();
  const deptHours = topDepts.map((root) => {
    const childIds = [root.id, ...getChildDeptIds(root.id)];
    const rows = units.filter((u) => childIds.includes(u.requesterDept) && inYear(u.parentSubmittedAt, year));
    const spentHours = rows
      .filter((u) => u.parentStage === "已完成" || u.parentStage === "关闭")
      .reduce((s, u) => s + u.actualHours, 0);
    const estimatedSpentHours = rows
      .filter((u) => u.parentStage !== "已完成" && u.parentStage !== "关闭")
      .reduce((s, u) => s + u.estimatedHours, 0);
    return {
      deptId: root.id,
      deptName: root.name,
      spentHours: Number(spentHours.toFixed(1)),
      estimatedSpentHours: Number(estimatedSpentHours.toFixed(1)),
    };
  });

  res.json({
    iterations: allIterations,
    // 供前端首次进入页面时用作默认选中项（单个迭代名）；用户后续可自己多选或选"全部迭代"
    currentIteration: current?.name ?? allIterations[0]?.name ?? null,
    iterationSummary,
    iterationTickets,
    annualSummary,
    yoyTrend,
    deptHours,
  });
});

// ---------- 部门统计 ----------
router.get("/departments", (req, res) => {
  // 看板口径与工单中心一致：先按「分类显示范围」配置收敛
  const tickets = store.visibleTickets;
  const yearParam = String(req.query.year ?? "all");
  const year = yearParam === "all" ? null : Number(yearParam);
  const deptIdsParam = req.query.deptIds ? String(req.query.deptIds).split(",") : null;

  const inScope = (t: Ticket) => (deptIdsParam ? deptIdsParam.includes(t.requesterDept) : true);
  const scoped = tickets.filter(inScope);

  const completed = scoped.filter((t) => t.status === "已完成" || t.status === "已解决");
  const closed = scoped.filter((t) => t.status === "关闭");
  // 未完成：工单阶段 != 已完成 且 != 关闭（已解决不计入未完成）
  const incomplete = scoped.filter((t) => t.stage !== "已完成" && t.stage !== "关闭");
  const spentHours = scoped
    .filter((t) => t.stage === "已完成" || t.stage === "关闭")
    .reduce((s, t) => s + t.actualHours, 0);
  const estimatedSpentHours = scoped
    .filter((t) => t.stage !== "已完成" && t.stage !== "关闭")
    .reduce((s, t) => s + t.estimatedHours, 0);

  const cards = {
    total: scoped.length,
    completed: completed.length,
    closed: closed.length,
    incomplete: incomplete.length,
    spentHours: Number(spentHours.toFixed(1)),
    estimatedSpentHours: Number(estimatedSpentHours.toFixed(1)),
  };

  const topDepts = getTopLevelDepartments();
  const byDept = topDepts.map((root) => {
    const childIds = [root.id, ...getChildDeptIds(root.id)];
    const rows = scoped.filter((t) => childIds.includes(t.requesterDept) && (year === null || inYear(t.submittedAt, year)));
    const rowsCompleted = rows.filter((t) => t.status === "已完成" || t.status === "已解决");
    const rowsClosed = rows.filter((t) => t.status === "关闭");
    const rowsIncomplete = rows.filter((t) => t.stage !== "已完成" && t.stage !== "关闭");
    const rowsSpent = rows.filter((t) => t.stage === "已完成" || t.stage === "关闭").reduce((s, t) => s + t.actualHours, 0);
    const rowsEstSpent = rows.filter((t) => t.stage !== "已完成" && t.stage !== "关闭").reduce((s, t) => s + t.estimatedHours, 0);
    return {
      deptId: root.id,
      deptName: root.name,
      total: rows.length,
      completed: rowsCompleted.length,
      closed: rowsClosed.length,
      incomplete: rowsIncomplete.length,
      spentHours: Number(rowsSpent.toFixed(1)),
      estimatedSpentHours: Number(rowsEstSpent.toFixed(1)),
    };
  });

  // 父级部门月度提交及完成趋势（默认全部父级部门汇总）
  const monthlyTrend = Array.from({ length: 12 }, (_, m) => {
    const submitted = scoped.filter(
      (t) => dayjs(t.submittedAt).year() === (year ?? 2026) && dayjs(t.submittedAt).month() === m
    ).length;
    const done = scoped.filter(
      (t) =>
        t.actualCompleteTime &&
        dayjs(t.actualCompleteTime).year() === (year ?? 2026) &&
        dayjs(t.actualCompleteTime).month() === m
    ).length;
    return { month: m + 1, submitted, completed: done };
  });

  const spentHoursRatio = byDept.map((d) => ({ deptName: d.deptName, value: d.spentHours }));
  const estimatedHoursRatio = byDept.map((d) => ({ deptName: d.deptName, value: d.estimatedSpentHours }));

  // 各部门月度工时花费占比：按提交月份切片（未选具体年份时固定看 2026 年，
  // 跟上面"父级部门月度提交及完成趋势"用的是同一个口径），工时统计沿用"统计单元"
  // 口径（没有子需求按工单自己算，有子需求按每条子需求各自算），
  // 每个部门在当月的份额 = 该部门当月数值 / 当月所有部门合计数值 * 100
  const ratioYear = year ?? 2026;
  const units = scoped.flatMap(expandToDevHourUnits);
  const monthlyDeptHours = topDepts.map((root) => {
    const childIds = [root.id, ...getChildDeptIds(root.id)];
    const monthly = Array.from({ length: 12 }, (_, m) => {
      const rows = units.filter(
        (u) =>
          childIds.includes(u.requesterDept) &&
          dayjs(u.parentSubmittedAt).year() === ratioYear &&
          dayjs(u.parentSubmittedAt).month() === m
      );
      const spentHours = rows
        .filter((u) => u.parentStage === "已完成" || u.parentStage === "关闭")
        .reduce((s, u) => s + u.actualHours, 0);
      const estimatedSpentHours = rows
        .filter((u) => u.parentStage !== "已完成" && u.parentStage !== "关闭")
        .reduce((s, u) => s + u.estimatedHours, 0);
      return { spentHours, estimatedSpentHours };
    });
    return { deptId: root.id, deptName: root.name, monthly };
  });

  const monthlySpentTotal = Array.from({ length: 12 }, (_, m) =>
    monthlyDeptHours.reduce((s, d) => s + d.monthly[m].spentHours, 0)
  );
  const monthlyEstTotal = Array.from({ length: 12 }, (_, m) =>
    monthlyDeptHours.reduce((s, d) => s + d.monthly[m].estimatedSpentHours, 0)
  );
  const pct = (v: number, total: number) => (total > 0 ? Number(((v / total) * 100).toFixed(1)) : 0);

  const monthlySpentSharePercent = monthlyDeptHours.map((d) => ({
    deptId: d.deptId,
    deptName: d.deptName,
    values: d.monthly.map((m, i) => pct(m.spentHours, monthlySpentTotal[i])),
  }));
  const monthlyEstimatedSharePercent = monthlyDeptHours.map((d) => ({
    deptId: d.deptId,
    deptName: d.deptName,
    values: d.monthly.map((m, i) => pct(m.estimatedSpentHours, monthlyEstTotal[i])),
  }));

  res.json({
    cards,
    byDept,
    monthlyTrend,
    spentHoursRatio,
    estimatedHoursRatio,
    monthlySpentSharePercent,
    monthlyEstimatedSharePercent,
    departments: store.departments,
  });
});

export default router;
