export type Role = "admin" | "it_handler" | "requester" | "developer" | "tester" | "pm";

export interface User {
  id: string;
  name: string;
  pinyin: string;
  role: Role;
  departmentId: string;
  avatarColor: string;
}

export interface Department {
  id: string;
  name: string;
  parentId: string | null;
  children?: Department[];
}

export type TicketStatus =
  | "待处理"
  | "梳理中"
  | "已梳理"
  | "规划中"
  | "开发完成"
  | "实现中"
  | "转测试"
  | "测试中"
  | "待验收"
  | "已验收"
  | "已解决"
  | "已完成"
  | "关闭";

export type TicketStage = "待排期" | "方案梳理" | "开发中" | "测试验收中" | "已完成" | "关闭";

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
  title: string;
  developer: string;
  currentHandler: string;
  monthlyPlan: string[];
  iteration: IterationRef | null;
  estimatedHours: number;
  actualHours: number;
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
  currentHandler: string;
  itHandler: string;
  developer: string[];
  stage: TicketStage;
  status: TicketStatus;
  devStatus: string | null;
  urgent: boolean;
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
}

export interface InSiteMessage {
  id: string;
  toRole: Role;
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

export const STAGE_COLORS: Record<TicketStage, string> = {
  待排期: "default",
  方案梳理: "gold",
  开发中: "blue",
  测试验收中: "purple",
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
