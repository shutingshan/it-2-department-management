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

// 账号配置支持的登录角色：管理员/IT受理人/需求方。开发人员/测试人员/产品经理仅作为工单数据里的人员标签存在，不具备登录能力
export type AccountRole = "admin" | "it_handler" | "requester";

export interface Account {
  id: string;
  userId: string; // 关联 USERS 中的人员记录，姓名/拼音码/部门等信息取自该记录
  name: string;
  pinyin: string;
  role: AccountRole;
  locked?: boolean; // 系统默认超级管理员账号，不可编辑、不可删除
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
  tapdUrl: string | null; // TAPD 地址
  title: string;
  productManager: string; // 产品经理
  developer: string;
  tester: string; // 测试人员
  currentHandler: string; // 处理人
  tapdStatus: string | null; // TAPD 状态
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
  watcher: string[]; // 关注人
  currentHandler: string; // 当前处理人
  itHandler: string; // IT 受理人
  developer: string[]; // 开发人员（去重）
  stage: TicketStage; // 工单阶段
  status: TicketStatus; // 状态
  devStatus: string | null; // TAPD 需求开发状态（用于阶段映射）
  urgent: string; // 紧急（文本输入，如"紧急"/"急"；空字符串表示不紧急。需求方等角色手动维护，跟优先级是两回事）
  remark: string; // 备注（工单中心内维护，所有角色可实时编辑）
  priority: string | null; // 优先级（当曲云字段，如 High/Middle/Low）
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
  tapdErrorNote: SyncErrorNote | null; // 获取TAPD信息异常时反填
  dangquyunErrorNote: SyncErrorNote | null; // 同步当曲云工单信息异常时反填
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

// 工时偏差 = 实际工时 - 预估工时
export function hoursDeviation(t: Pick<Ticket, "estimatedHours" | "actualHours">): number {
  return Number((t.actualHours - t.estimatedHours).toFixed(1));
}
