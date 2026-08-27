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

// "更新工单"下拉里可以单独授权的操作。这些操作都会真的去抓当曲云/TAPD，
// 耗时长且会改写全量数据，不该人人都能点，因此做成按账号勾选
export type SyncPermission =
  | "fetch-incremental"
  | "fetch-full"
  | "update"
  | "tapd"
  | "tapd-login";

export const SYNC_PERMISSIONS: { key: SyncPermission; label: string }[] = [
  { key: "fetch-incremental", label: "获取新工单" },
  { key: "fetch-full", label: "全量获取（用于数据初始化）" },
  { key: "update", label: "更新工单（按当前筛选）" },
  { key: "tapd", label: "获取TAPD信息（按当前筛选）" },
  { key: "tapd-login", label: "TAPD扫码登录" },
];

// 可按账号单独授权的菜单。缺陷跟进是一块跨部门共用的看板，进去就能看到并编辑
// 全量缺陷，谁能进由管理员在账号配置里直接勾选，不从工单数据里推断
export type MenuPermission = "defects";

export const MENU_PERMISSIONS: { key: MenuPermission; label: string }[] = [
  { key: "defects", label: "缺陷跟进" },
];

// 缺陷跟进左侧应用树的分组节点。一个节点对应一个显示名称 + 若干归属应用，
// 用来把零散的应用按业务线归拢（比如「供应链」下挂 ERP-业务、集采）。
// 未配置任何节点时，树回落到原始形态：每个归属应用各占一个节点
// 「需方期望月度」下拉候选值的来源。三种取法各有适用场景，见 expectedMonth.ts
// monthlyPlan：取自工单已有的月度计划字段；generated：按当前月份自动生成；custom：手工维护的清单
export type ExpectedMonthSourceMode = "monthlyPlan" | "generated" | "custom";

export interface ExpectedMonthSource {
  mode: ExpectedMonthSourceMode;
  includeSubTickets: boolean; // monthlyPlan 模式：是否并入子需求的月度计划
  pastMonths: number; // generated 模式：往前生成几个月
  futureMonths: number; // generated 模式：往后生成几个月
  customMonths: string[]; // custom 模式：手工维护的月份清单（YYYY-MM）
  includeExistingValues: boolean; // 是否并入已填写的期望月度，避免来源收窄后历史值选不回来
}

export interface DefectTreeNode {
  id: string;
  name: string;
  apps: string[];
}

// 范围配置项。两处用途互相独立，配置为空都表示"不限制"（避免升级后老部署行为突变）：
// - 受理人范围：「获取新工单」「全量获取」时只导入这些受理人的工单
// - 分类范围：工单中心的显示范围，列表、统计卡片、导出三者口径一致
export interface ScopeConfigItem {
  id: string;
  value: string;
}

export interface Account {
  id: string;
  userId: string; // 关联 USERS 中的人员记录，姓名/拼音码/部门等信息取自该记录
  name: string;
  pinyin: string;
  role: AccountRole;
  locked?: boolean; // 系统默认超级管理员账号，不可编辑、不可删除
  // "更新工单"下拉里该账号被授权的操作；管理员不受此字段限制（始终全部可用）。
  // 未配置（undefined）按"一个都没授权"处理——这类操作影响全量数据，默认不给更安全
  syncPermissions?: SyncPermission[];
  // 该账号被授权的菜单；管理员不受此字段限制（始终全部可用）。
  // 未配置（undefined）按"一个都没授权"处理，跟 syncPermissions 一致
  menuPermissions?: MenuPermission[];
}

// 状态：来自当曲云/TAPD原始状态
// 状态取值的唯一来源：类型、抓取时的合法性校验、页面上的筛选下拉与排除配置候选
// 全都从这个数组派生。以前类型和运行时数组各写一份，新增一个状态值要改好几处，
// 漏改的那处就会把新状态当成未知值处理
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
  expectedMonth: string | null; // 需方期望月度（YYYY-MM），需方自行维护，候选值来源可配置
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
  // 以下为「缺陷跟进」页面维护的字段，跟当曲云/TAPD 同步无关，纯人工填写
  hasTestCase: boolean | null; // 是否有测试用例
  testCaseSupplemented: boolean | null; // 是否已补充测试用例
  hasAutomatedTest: boolean | null; // 是否做自动化测试
  automationPlanCompleteTime: string | null; // 自动化计划完成时间
  completionStatus: "" | "未开始" | "进行中" | "已完成"; // 完成情况
  spentHours: number | null; // 花费工时
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
