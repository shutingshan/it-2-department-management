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

// ---------- 首页统计 ----------
router.get("/home", (req, res) => {
  const yearParam = String(req.query.year ?? "2026");
  const year = yearParam === "all" ? null : Number(yearParam);
  const tickets = store.tickets;

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
  const monthlyTrend = Object.keys(byHandler).map((handler) => {
    const series = years.flatMap((y) =>
      Array.from({ length: 12 }, (_, m) => {
        const monthTickets = tickets.filter(
          (t) => t.itHandler === handler && dayjs(t.submittedAt).year() === y && dayjs(t.submittedAt).month() === m
        );
        const received = monthTickets.length;
        const done = tickets.filter(
          (t) =>
            t.itHandler === handler &&
            t.actualCompleteTime &&
            dayjs(t.actualCompleteTime).year() === y &&
            dayjs(t.actualCompleteTime).month() === m
        ).length;
        return { year: y, month: m + 1, received, completed: done };
      })
    );
    return { handler, series };
  });

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
router.get("/dev-hours", (req, res) => {
  const tickets = store.tickets;
  const allIterations = Array.from(
    new Map(
      tickets.flatMap((t) => t.iterations).map((it) => [it.name, it])
    ).values()
  ).sort((a, b) => (a.start < b.start ? 1 : -1)); // 倒序

  const today = dayjs("2026-07-24");
  let current = allIterations.find((it) => !today.isBefore(it.start) && !today.isAfter(it.end));
  if (!current) {
    // 回退到当前日期之前最近的迭代
    current = allIterations.find((it) => dayjs(it.end).isBefore(today));
  }
  const selectedIteration = String(req.query.iteration ?? current?.name ?? allIterations[0]?.name);

  function ticketsInIteration(name: string): Ticket[] {
    return tickets.filter(
      (t) => t.iterations.some((i) => i.name === name) || t.subTickets.some((s) => s.iteration?.name === name)
    );
  }

  const iterationTicketsRaw = ticketsInIteration(selectedIteration);
  const iterationSummaryMap: Record<string, { ticketCount: number; estimatedHours: number; actualHours: number }> = {};
  iterationTicketsRaw.forEach((t) => {
    const devs = t.developer.length ? t.developer : ["未分配"];
    devs.forEach((dev) => {
      if (!iterationSummaryMap[dev]) iterationSummaryMap[dev] = { ticketCount: 0, estimatedHours: 0, actualHours: 0 };
      iterationSummaryMap[dev].ticketCount += 1;
      iterationSummaryMap[dev].estimatedHours += t.estimatedHours;
      iterationSummaryMap[dev].actualHours += t.actualHours;
    });
  });
  const iterationSummary = Object.entries(iterationSummaryMap).map(([developer, v]) => ({
    developer,
    ticketCount: v.ticketCount,
    estimatedHours: Number(v.estimatedHours.toFixed(1)),
    actualHours: Number(v.actualHours.toFixed(1)),
    diffHours: Number((v.actualHours - v.estimatedHours).toFixed(1)),
  }));

  // 迭代工单列表（仅保留指定字段）
  const iterationTickets = iterationTicketsRaw.map((t) => ({
    code: t.code,
    tapdUrl: t.tapdUrl,
    owningApp: t.owningApp,
    requester: t.requester,
    title: t.title,
    content: t.content,
    iteration: selectedIteration,
    estimatedHours: t.estimatedHours,
    actualHours: t.actualHours,
    hoursDeviation: hoursDeviation(t),
  }));

  // 每个开发每年完成的工单数、预估/实际总工时、差异工时
  const year = Number(req.query.year ?? 2026);
  const annualMap: Record<string, { completedCount: number; estimatedHours: number; actualHours: number }> = {};
  tickets
    .filter((t) => (t.status === "已完成" || t.status === "已解决") && inYear(t.actualCompleteTime, year))
    .forEach((t) => {
      const devs = t.developer.length ? t.developer : ["未分配"];
      devs.forEach((dev) => {
        if (!annualMap[dev]) annualMap[dev] = { completedCount: 0, estimatedHours: 0, actualHours: 0 };
        annualMap[dev].completedCount += 1;
        annualMap[dev].estimatedHours += t.estimatedHours;
        annualMap[dev].actualHours += t.actualHours;
      });
    });
  const annualSummary = Object.entries(annualMap).map(([developer, v]) => ({
    developer,
    completedCount: v.completedCount,
    estimatedHours: Number(v.estimatedHours.toFixed(1)),
    actualHours: Number(v.actualHours.toFixed(1)),
    diffHours: Number((v.actualHours - v.estimatedHours).toFixed(1)),
  }));

  const years = [2024, 2025, 2026];
  const yoyTrend = years.map((y) => {
    const done = tickets.filter(
      (t) => (t.status === "已完成" || t.status === "已解决") && inYear(t.actualCompleteTime, y)
    );
    return {
      year: y,
      estimatedHours: Number(done.reduce((s, t) => s + t.estimatedHours, 0).toFixed(1)),
      actualHours: Number(done.reduce((s, t) => s + t.actualHours, 0).toFixed(1)),
    };
  });

  res.json({
    iterations: allIterations,
    currentIteration: selectedIteration,
    iterationSummary,
    iterationTickets,
    annualSummary,
    yoyTrend,
  });
});

// ---------- 部门统计 ----------
router.get("/departments", (req, res) => {
  const tickets = store.tickets;
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

  res.json({ cards, byDept, monthlyTrend, spentHoursRatio, estimatedHoursRatio, departments: store.departments });
});

export default router;
