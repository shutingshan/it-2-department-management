import dayjs from "dayjs";
import { Ticket } from "./types";
import { filterByCard } from "./cards";

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

export function parseQuery(q: Record<string, unknown>): TicketQuery {
  return {
    search: q.search ? String(q.search).trim() : undefined,
    submittedFrom: q.submittedFrom ? String(q.submittedFrom) : undefined,
    submittedTo: q.submittedTo ? String(q.submittedTo) : undefined,
    stage: toArray(q.stage),
    status: toArray(q.status),
    urgent: q.urgent === "true" ? true : q.urgent === "false" ? false : undefined,
    monthlyPlan: toArray(q.monthlyPlan),
    iteration: toArray(q.iteration),
    owningApp: toArray(q.owningApp),
    requesterDept: toArray(q.requesterDept),
    requester: toArray(q.requester),
    watcher: toArray(q.watcher),
    itHandler: toArray(q.itHandler),
    hasTapd: q.hasTapd === "true" ? true : q.hasTapd === "false" ? false : undefined,
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
  if (q.urgent !== undefined) result = result.filter((t) => t.urgent === q.urgent);
  if (q.monthlyPlan?.length)
    result = result.filter((t) => t.monthlyPlan.some((m) => q.monthlyPlan!.includes(m)));
  if (q.iteration?.length)
    result = result.filter((t) => t.iterations.some((i) => q.iteration!.includes(i.name)));
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
