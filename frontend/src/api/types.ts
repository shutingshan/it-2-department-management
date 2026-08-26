export type Role = "admin" | "it_handler" | "requester" | "developer" | "tester" | "pm";

// 账号配置支持的登录角色：开发人员/测试人员/产品经理仅作为工单数据里的人员标签存在，不具备登录能力
export type AccountRole = "admin" | "it_handler" | "requester";

export interface User {
  id: string;
  name: string;
  pinyin: string;
  role: Role;
  departmentId: string;
  avatarColor: string;
  // 该账号被授权的"更新工单"操作；管理员由后端直接返回全部
  syncPermissions?: SyncPermission[];
}

// "更新工单"下拉里可以按账号单独授权的操作（跟后端 types.ts 的 SYNC_PERMISSIONS 一一对应）
export type SyncPermission = "fetch-incremental" | "fetch-full" | "update" | "tapd" | "tapd-login";

export const SYNC_PERMISSIONS: { key: SyncPermission; label: string }[] = [
  { key: "fetch-incremental", label: "获取新工单" },
  { key: "fetch-full", label: "全量获取（用于数据初始化）" },
  { key: "update", label: "更新工单（按当前筛选）" },
  { key: "tapd", label: "获取TAPD信息（按当前筛选）" },
  { key: "tapd-login", label: "TAPD扫码登录" },
];

// 取数与显示范围配置项（跟后端 types.ts 的 ScopeConfigItem 对应）
export interface ScopeConfigItem {
  id: string;
  value: string;
}

// handlers=获取工单受理人范围；categories=工单中心显示分类；
// excludedApps / excludedStatuses=工单中心排除的归属应用 / 状态（排除语义，跟前两者相反）；
// verifyCodes=抓取结果核验用的工单编号
export type ScopeKind =
  | "handlers"
  | "categories"
  | "excludedApps"
  | "excludedStatuses"
  | "verifyCodes";

export interface Account {
  id: string;
  userId: string;
  name: string;
  pinyin: string;
  role: AccountRole;
  locked?: boolean;
  syncPermissions?: SyncPermission[];
}

export interface Department {
  id: string;
  name: string;
  parentId: string | null;
  children?: Department[];
}

// 跟后端 types.ts 的 TICKET_STATUSES 保持一致。类型和筛选下拉都从这个数组派生，
// 不再各写一份——以前新增状态值要改好几处，漏改就会在页面上筛不到
export const TICKET_STATUSES = [
  "新制",
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
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export type TicketStage =
  | "待分配"
  | "待补充资料"
  | "方案梳理"
  | "待排期"
  | "已排期"
  | "开发中"
  | "测试验收"
  | "已完成"
  | "关闭";

export interface IterationRef {
  name: string;
  start: string;
  end: string;
}

export interface Attachment {
  name: string;
  url: string;
}

export interface ChangeLogEntry {
  field: string;
  oldValue: string;
  newValue: string;
  time: string;
  actor: string;
}

export interface ProcessingNote {
  time: string;
  actor: string;
  content: string;
}

export interface SubTicket {
  id: string;
  code: string;
  tapdUrl: string | null;
  title: string;
  productManager: string;
  developer: string;
  tester: string;
  currentHandler: string;
  tapdStatus: string | null;
  monthlyPlan: string[];
  iteration: IterationRef | null;
  estimatedHours: number;
  actualHours: number;
}

export interface SyncErrorNote {
  time: string;
  message: string;
}

export interface Ticket {
  id: string;
  code: string;
  tapdUrl: string | null;
  category: string;
  owningApp: string;
  module: string;
  title: string;
  content: string;
  attachments: Attachment[];
  requester: string;
  requesterPinyin: string;
  requesterDept: string;
  watcher: string[];
  currentHandler: string;
  itHandler: string;
  developer: string[];
  stage: TicketStage;
  status: TicketStatus;
  devStatus: string | null;
  urgent: string; // 紧急：文本输入，空字符串表示不紧急
  remark: string;
  priority: string | null;
  isReturned: boolean;
  monthlyPlan: string[];
  iterations: IterationRef[];
  expectedTriageTime: string | null;
  actualTriageTime: string | null;
  expectedCompleteTime: string | null;
  actualCompleteTime: string | null;
  estimatedHours: number;
  actualHours: number;
  submittedAt: string;
  closedAt: string | null;
  subTickets: SubTicket[];
  processingNotes: ProcessingNote[];
  changeHistory: ChangeLogEntry[];
  slaFlag: string | null;
  tapdErrorNote: SyncErrorNote | null;
  dangquyunErrorNote: SyncErrorNote | null;
  // 缺陷跟进页面维护的字段
  hasTestCase: boolean | null;
  testCaseSupplemented: boolean | null;
  hasAutomatedTest: boolean | null;
  automationPlanCompleteTime: string | null;
  completionStatus: "" | "未开始" | "进行中" | "已完成";
  spentHours: number | null;
}

export interface InSiteMessage {
  id: string;
  toRole: Role;
  itHandler: string;
  requesterName: string;
  action: string;
  time: string;
  ticketCode: string;
  read: boolean;
}

export interface LogEntry {
  id: string;
  type: "获取新工单" | "更新工单" | "同步TAPD";
  time: string;
  actor: string;
  success: boolean;
  failReason: string | null;
  detail: string;
}

export interface SyncJob {
  id: string;
  type: "fetch_new" | "update_tickets" | "sync_tapd";
  status: "running" | "done" | "terminated" | "failed";
  total: number;
  processed: number;
  success: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
  failReasons: string[];
}

export function hoursDeviation(t: Pick<Ticket, "estimatedHours" | "actualHours">): number {
  return Number((t.actualHours - t.estimatedHours).toFixed(1));
}

// TAPD 迭代字段可能带有"（当前迭代）"后缀（如 260710～260712（当前迭代）），展示前需先截掉再去重
export function stripCurrentIterationTag(name: string): string {
  return name.replace(/[（(]当前迭代[）)]/g, "").trim();
}

export function formatIterations(refs: Pick<IterationRef, "name">[]): string {
  return Array.from(new Set(refs.map((i) => stripCurrentIterationTag(i.name)).filter(Boolean))).join("、") || "-";
}

export const STAGE_COLORS: Record<TicketStage, string> = {
  待分配: "default",
  待补充资料: "orange",
  方案梳理: "gold",
  待排期: "default",
  已排期: "cyan",
  开发中: "blue",
  测试验收: "purple",
  已完成: "green",
  关闭: "default",
};

export const ROLE_LABELS: Record<Role, string> = {
  admin: "管理员",
  it_handler: "IT受理人",
  requester: "需求方",
  developer: "开发人员",
  tester: "测试人员",
  pm: "产品经理",
};
