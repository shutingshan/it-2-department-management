export type Role =
  | "admin"
  | "it_handler"
  | "requester"
  | "developer"
  | "tester"
  | "pm";

export interface User {
  id: string;
  name: string;
  pinyin: string; // 拼音码，例如 谢敏敏 -> xmm
  role: Role;
  departmentId: string;
  avatarColor: string;
}

export interface Department {
  id: string;
  name: string;
  parentId: string | null;
}

// 状态：来自当曲云/TAPD原始状态
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

// 工单阶段：系统计算/同步映射得出，决定看板/统计/筛选口径
export type TicketStage =
  | "待排期"
  | "方案梳理"
  | "开发中"
  | "测试验收中"
  | "已完成"
  | "关闭";

export interface IterationRef {
  name: string;
  start: string; // ISO date
  end: string; // ISO date
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
  code: string; // 编号 GDyyyymmddNN
  tapdUrl: string | null; // TAPD 地址
  category: string; // 分类：需求/数据处理...
  owningApp: string; // 归属应用
  module: string; // 模块
  title: string;
  content: string;
  attachments: Attachment[];
  requester: string; // 发起人
  requesterPinyin: string;
  requesterDept: string; // 发起部门 (department id)
  currentHandler: string; // 当前处理人
  itHandler: string; // IT 受理人
  developer: string[]; // 开发人员（去重）
  stage: TicketStage; // 工单阶段
  status: TicketStatus; // 状态
  devStatus: string | null; // TAPD 需求开发状态（用于阶段映射）
  urgent: boolean; // 紧急
  isReturned: boolean; // 是否退回
  monthlyPlan: string[]; // 月度计划（去重）
  iterations: IterationRef[]; // 迭代子表
  expectedTriageTime: string | null; // 预计梳理完成时间（当曲云）
  actualTriageTime: string | null; // 实际梳理完成时间（当曲云）
  expectedCompleteTime: string | null; // 预计完成时间（当曲云）
  actualCompleteTime: string | null; // 实际完成时间（当曲云/TAPD）
  estimatedHours: number; // 预估工时
  actualHours: number; // 实际工时
  submittedAt: string; // 提交时间
  closedAt: string | null; // 关闭时间
  subTickets: SubTicket[]; // 子需求
  processingNotes: ProcessingNote[]; // 处理记录
  changeHistory: ChangeLogEntry[]; // 变更记录
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

// 工时偏差 = 实际工时 - 预估工时
export function hoursDeviation(t: Pick<Ticket, "estimatedHours" | "actualHours">): number {
  return Number((t.actualHours - t.estimatedHours).toFixed(1));
}
