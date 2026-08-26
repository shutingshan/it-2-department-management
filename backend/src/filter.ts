import dayjs from "dayjs";
import { Ticket } from "./types";
import { filterByCard } from "./cards";
import { stripCurrentIterationTag } from "./mapping";

export interface TicketQuery {
  search?: string;
  submittedFrom?: string;
  submittedTo?: string;
  stage?: string[];
  status?: string[];
  urgent?: boolean;
  monthlyPlan?: string[];
  iteration?: string[];
  owningApp?: string[];
  category?: string[];
  requesterDept?: string[];
  requester?: string[];
  watcher?: string[];
  itHandler?: string[];
  hasTapd?: boolean;
  cardKey?: string;
  sortField?: string;
  sortOrder?: "asc" | "desc";
  // 缺陷跟进页的人工维护字段。三态字段（是/否/未填写）用字符串数组表达，
  // 而不是复用上面 urgent 那种 boolean——boolean 表达不了"未填写"这第三种取值，
  // 也没法多选（比如同时看"否"和"未填写"这些待补齐的）
  hasTestCase?: string[];
  testCaseSupplemented?: string[];
  hasAutomatedTest?: string[];
  completionStatus?: string[];
  automationFrom?: string;
  automationTo?: string;
  spentHoursMin?: number;
  spentHoursMax?: number;
  // 头部「切换人员」选中的查看对象。刻意不复用 itHandler：筛选栏里的「受理人」下拉用的是
  // itHandler，两者若共用一个键会互相覆盖；而且这里的口径是「受理人或发起人」，比 itHandler 宽
  viewTargets?: string[];
}

// "未填写"在筛选参数里的表示。用不会跟真实取值撞车的哨兵值，
// 空字符串会被 toArray 当成"没传"而整条筛选失效
export const EMPTY_TOKEN = "__empty__";

function toArray(v: unknown): string[] | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (Array.isArray(v)) return v as string[];
  return String(v).split(",").filter(Boolean);
}

// 布尔筛选项要兼容两种来源：列表走 GET，参数从查询串来，拿到的是字符串 "true"/"false"；
// 「更新工单」「获取TAPD信息」把筛选条件放在 JSON body 里传，拿到的是真正的布尔值。
// 只判断字符串的话，后者会被当成没填而整条筛选被忽略，导致同步范围比列表里看到的大
function toBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

// 数值筛选同样要兼容 GET 查询串（字符串）与 JSON body（数字）两种来源
function toNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// 三态字段（boolean | null）匹配：null 只被"未填写"命中
function matchesTriState(value: boolean | null | undefined, selected: string[]): boolean {
  if (value === null || value === undefined) return selected.includes(EMPTY_TOKEN);
  return selected.includes(value ? "yes" : "no");
}

export function parseQuery(q: Record<string, unknown>): TicketQuery {
  return {
    search: q.search ? String(q.search).trim() : undefined,
    submittedFrom: q.submittedFrom ? String(q.submittedFrom) : undefined,
    submittedTo: q.submittedTo ? String(q.submittedTo) : undefined,
    stage: toArray(q.stage),
    status: toArray(q.status),
    urgent: toBool(q.urgent),
    monthlyPlan: toArray(q.monthlyPlan),
    iteration: toArray(q.iteration),
    owningApp: toArray(q.owningApp),
    category: toArray(q.category),
    requesterDept: toArray(q.requesterDept),
    requester: toArray(q.requester),
    watcher: toArray(q.watcher),
    itHandler: toArray(q.itHandler),
    hasTapd: toBool(q.hasTapd),
    cardKey: q.cardKey ? String(q.cardKey) : undefined,
    sortField: q.sortField ? String(q.sortField) : "submittedAt",
    sortOrder: q.sortOrder === "asc" ? "asc" : "desc",
    hasTestCase: toArray(q.hasTestCase),
    testCaseSupplemented: toArray(q.testCaseSupplemented),
    hasAutomatedTest: toArray(q.hasAutomatedTest),
    completionStatus: toArray(q.completionStatus),
    automationFrom: q.automationFrom ? String(q.automationFrom) : undefined,
    automationTo: q.automationTo ? String(q.automationTo) : undefined,
    spentHoursMin: toNumber(q.spentHoursMin),
    spentHoursMax: toNumber(q.spentHoursMax),
    viewTargets: toArray(q.viewTargets),
  };
}

// 拼音码模糊匹配：支持如 "谢敏敏" 用 "xmm" 命中
function matchesSearch(t: Ticket, kw: string): boolean {
  const lower = kw.toLowerCase();
  const haystack = [
    t.code,
    t.title,
    t.content,
    t.requester,
    t.requesterPinyin,
    t.currentHandler,
    t.itHandler,
    t.tapdUrl ?? "",
    ...t.developer,
    ...t.watcher,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(lower);
}

export function applyFilters(tickets: Ticket[], q: TicketQuery): Ticket[] {
  let result = tickets;
  if (q.search) result = result.filter((t) => matchesSearch(t, q.search!));
  if (q.submittedFrom) result = result.filter((t) => t.submittedAt >= q.submittedFrom!);
  if (q.submittedTo) result = result.filter((t) => t.submittedAt <= q.submittedTo!);
  if (q.stage?.length) result = result.filter((t) => q.stage!.includes(t.stage));
  if (q.status?.length) result = result.filter((t) => q.status!.includes(t.status));
  // 紧急是文本字段，筛选按"有值/无值"判断，而不是等于某个具体文本
  if (q.urgent !== undefined) result = result.filter((t) => !!t.urgent.trim() === q.urgent);
  if (q.monthlyPlan?.length)
    result = result.filter((t) => t.monthlyPlan.some((m) => q.monthlyPlan!.includes(m)));
  if (q.iteration?.length)
    result = result.filter((t) =>
      t.iterations.some((i) => q.iteration!.includes(stripCurrentIterationTag(i.name)))
    );
  if (q.owningApp?.length) result = result.filter((t) => q.owningApp!.includes(t.owningApp));
  if (q.category?.length) result = result.filter((t) => q.category!.includes(t.category));
  if (q.requesterDept?.length) result = result.filter((t) => q.requesterDept!.includes(t.requesterDept));
  if (q.requester?.length) result = result.filter((t) => q.requester!.includes(t.requester));
  if (q.watcher?.length) result = result.filter((t) => t.watcher.some((w) => q.watcher!.includes(w)));
  if (q.itHandler?.length) result = result.filter((t) => q.itHandler!.includes(t.itHandler));
  if (q.hasTapd !== undefined) result = result.filter((t) => (t.tapdUrl !== null) === q.hasTapd);

  // 缺陷跟进的人工维护字段
  if (q.hasTestCase?.length)
    result = result.filter((t) => matchesTriState(t.hasTestCase, q.hasTestCase!));
  if (q.testCaseSupplemented?.length)
    result = result.filter((t) => matchesTriState(t.testCaseSupplemented, q.testCaseSupplemented!));
  if (q.hasAutomatedTest?.length)
    result = result.filter((t) => matchesTriState(t.hasAutomatedTest, q.hasAutomatedTest!));
  // 完成情况空字符串＝未填写，映射到哨兵值再比对
  if (q.completionStatus?.length)
    result = result.filter((t) => q.completionStatus!.includes(t.completionStatus || EMPTY_TOKEN));
  // 时间/工时区间：未填写的一律不落在任何区间内（跟"筛了范围就是要看填了值的"直觉一致）
  if (q.automationFrom)
    result = result.filter((t) => !!t.automationPlanCompleteTime && t.automationPlanCompleteTime >= q.automationFrom!);
  if (q.automationTo)
    result = result.filter((t) => !!t.automationPlanCompleteTime && t.automationPlanCompleteTime <= q.automationTo!);
  if (q.spentHoursMin !== undefined)
    result = result.filter((t) => t.spentHours !== null && t.spentHours >= q.spentHoursMin!);
  if (q.spentHoursMax !== undefined)
    result = result.filter((t) => t.spentHours !== null && t.spentHours <= q.spentHoursMax!);

  // 「切换人员」：受理人或发起人命中任一即可，跟缺陷页「本人可见」的口径保持一致
  if (q.viewTargets?.length)
    result = result.filter((t) => q.viewTargets!.includes(t.itHandler) || q.viewTargets!.includes(t.requester));

  if (q.cardKey) result = filterByCard(result, q.cardKey);

  const field = q.sortField ?? "submittedAt";
  const order = q.sortOrder ?? "desc";
  result = [...result].sort((a: any, b: any) => {
    const av = a[field] ?? "";
    const bv = b[field] ?? "";
    if (av === bv) return 0;
    const cmp = av > bv ? 1 : -1;
    return order === "asc" ? cmp : -cmp;
  });
  return result;
}

export function isSameYear(dateStr: string | null, year: number): boolean {
  if (!dateStr) return false;
  return dayjs(dateStr).year() === year;
}

// 需求方仅能查看发起人或关注人包含本人的数据；管理员/IT受理人不受此限制（IT受理人的限制体现在编辑权限上，不影响查看）
// 按登录身份圈定可见范围（管理员不受限，能看全部）：
// - 需求方：只看自己发起的、或把自己列为关注人的工单
// - IT受理人：只看 IT受理人 是自己的工单
// 工单中心的显示范围：分类范围配置非空时，只显示配置里的分类。
// 列表、统计卡片、导出都要走这里，否则会出现「卡片数量跟列表条数对不上」
export function applyDisplayScope(tickets: Ticket[], categories: string[]): Ticket[] {
  if (!categories.length) return tickets;
  return tickets.filter((t) => categories.includes(t.category));
}

// 归属应用排除名单：命中的工单不显示。
// 注意语义跟上面的分类范围是反的——分类范围是"只留配置里的"，这里是"去掉配置里的"。
// 之所以用排除而不是保留：归属应用会随业务不断新增，用保留的话每上一个新应用
// 都得记得来这里补一条，漏了就整个应用的工单都看不见
export function applyOwningAppExclusion(tickets: Ticket[], excludedApps: string[]): Ticket[] {
  if (!excludedApps.length) return tickets;
  return tickets.filter((t) => !excludedApps.includes(t.owningApp));
}

// 状态排除名单，语义与上面的归属应用排除完全一致，只是换个字段。
// 典型用法是把"关闭""已完成"这类不需要日常盯的状态从工单中心收起来
export function applyStatusExclusion(tickets: Ticket[], excludedStatuses: string[]): Ticket[] {
  if (!excludedStatuses.length) return tickets;
  return tickets.filter((t) => !excludedStatuses.includes(t.status));
}

export function scopeForActor(tickets: Ticket[], actor?: string, actorRole?: string): Ticket[] {
  if (!actor) return tickets;
  if (actorRole === "requester") {
    return tickets.filter((t) => t.requester === actor || t.watcher.includes(actor));
  }
  if (actorRole === "it_handler") {
    return tickets.filter((t) => t.itHandler === actor);
  }
  return tickets;
}

// 缺陷跟进页的可见范围，跟工单中心刻意不同：只要「受理人」或「发起人」是本人就能看到。
// 工单中心那套按角色分叉（受理人只看自己受理的、需求方只看自己发起或关注的）在这里不合用——
// 缺陷要两边一起跟：提缺陷的人要能看到修得怎么样，修缺陷的人要能看到自己手上有哪些。
// 管理员仍然看全部，否则没人能纵览所有缺陷
export function scopeForDefectActor(tickets: Ticket[], actor?: string, actorRole?: string): Ticket[] {
  if (!actor || actorRole === "admin") return tickets;
  return tickets.filter((t) => t.itHandler === actor || t.requester === actor);
}

export function canViewTicket(ticket: Ticket, actor?: string, actorRole?: string): boolean {
  if (!actor) return true;
  if (actorRole === "requester") {
    return ticket.requester === actor || ticket.watcher.includes(actor);
  }
  if (actorRole === "it_handler") {
    return ticket.itHandler === actor;
  }
  return true;
}
