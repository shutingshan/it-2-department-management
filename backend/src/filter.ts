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
  requesterDept?: string[];
  requester?: string[];
  watcher?: string[];
  itHandler?: string[];
  hasTapd?: boolean;
  cardKey?: string;
  sortField?: string;
  sortOrder?: "asc" | "desc";
}

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
    requesterDept: toArray(q.requesterDept),
    requester: toArray(q.requester),
    watcher: toArray(q.watcher),
    itHandler: toArray(q.itHandler),
    hasTapd: toBool(q.hasTapd),
    cardKey: q.cardKey ? String(q.cardKey) : undefined,
    sortField: q.sortField ? String(q.sortField) : "submittedAt",
    sortOrder: q.sortOrder === "asc" ? "asc" : "desc",
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
  if (q.requesterDept?.length) result = result.filter((t) => q.requesterDept!.includes(t.requesterDept));
  if (q.requester?.length) result = result.filter((t) => q.requester!.includes(t.requester));
  if (q.watcher?.length) result = result.filter((t) => t.watcher.some((w) => q.watcher!.includes(w)));
  if (q.itHandler?.length) result = result.filter((t) => q.itHandler!.includes(t.itHandler));
  if (q.hasTapd !== undefined) result = result.filter((t) => (t.tapdUrl !== null) === q.hasTapd);
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
