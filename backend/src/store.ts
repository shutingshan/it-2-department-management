import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import { DEPARTMENTS, SEED_ADMIN, generateAccounts } from "./seed";
import { buildUserDirectory } from "./userDirectory";
import { applyDisplayScope, applyOwningAppExclusion, applyStatusExclusion } from "./filter";
import { Account, ChangeLogEntry, DefectTreeNode, Department, ScopeConfigItem, InSiteMessage, LogEntry, Ticket, User } from "./types";

// 工单/处理记录/站内信/同步日志是真实业务数据（不是每次启动都重新生成的模拟数据），
// 必须落盘持久化，否则进程一重启（比如 ts-node-dev 检测到文件变化自动重启）就会全部丢失。
// 现阶段没有引入真正的数据库，先用一份 JSON 文件做最简单的持久化：定时落盘 + 进程退出前落盘
const DATA_DIR = path.join(__dirname, "../data");
const DATA_FILE = path.join(DATA_DIR, "store.json");

// 缺陷跟进页的默认分类范围。不像其余范围配置那样「空=不限制」就够用：
// 这个页面的意义就是只看缺陷，一上来不限制反而会把需求也列进来
const DEFAULT_DEFECT_CATEGORIES = (): ScopeConfigItem[] => [{ id: uuid(), value: "缺陷" }];

interface PersistedState {
  tickets: Ticket[];
  messages: InSiteMessage[];
  logs: LogEntry[];
  lastUpdateTime: string;
  lastScheduledSyncDate: string | null;
  // 部门树与登录账号在页面上可以增删改（部门配置 / 账号管理），改完同样要落盘——
  // 否则进程一重启就回到 seed.ts 里的初始值，用户在页面上配了半天等于白配。
  // 人员目录（users）没有任何修改入口，只是账号选择器用的只读名单，仍然直接取 seed：
  // 一旦把它也落盘，以后更新 seed.ts 里的人员名单反而会被旧的落盘数据盖住、不生效
  departments: Department[];
  accounts: Account[];
  // 范围配置：受理人（取数范围）/ 分类（工单中心显示范围）/ 归属应用（排除名单）/
  // 校验工单编号（抓取结果核验），页面上可增删改，必须落盘
  fetchScopeHandlers: ScopeConfigItem[];
  displayCategories: ScopeConfigItem[];
  excludedOwningApps: ScopeConfigItem[];
  excludedStatuses: ScopeConfigItem[];
  verifyTicketCodes: ScopeConfigItem[];
  // 缺陷跟进页的分类范围。跟 displayCategories（工单中心）刻意分开：
  // 工单中心通常只留「需求」，缺陷跟进要看的正是被它挡掉的那些分类
  defectCategories: ScopeConfigItem[];
  // 缺陷跟进左侧应用树的分组节点；为空表示按原始形态（一个应用一个节点）展示
  defectTreeNodes: DefectTreeNode[];
}

interface SyncJob {
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

class Store {
  // 工单/处理记录/站内信/同步日志均为真实数据，不再生成模拟数据，改为从磁盘加载（见 load()）；
  // 部门/账号首次启动用 seed 打底，之后以落盘数据为准；人员目录始终取 seed
  tickets: Ticket[] = [];
  departments: Department[] = DEPARTMENTS;
  accounts: Account[] = generateAccounts();

  // 人员目录不是一份独立维护的数据，而是从真实工单数据里实时汇总出来的（受理人/发起人/
  // 开发人员/处理人/关注人），保证跟当曲云同步回来的真人对得上——seed 里那份是原型阶段的
  // 示例名单，跟真实人员对不上会导致真人拿不到账号。锁定的默认管理员始终保留在最前面
  get users(): User[] {
    return buildUserDirectory(this.tickets, this.departments, SEED_ADMIN);
  }
  messages: InSiteMessage[] = [];
  logs: LogEntry[] = [];
  lastUpdateTime = "";
  currentJob: SyncJob | null = null;
  // 每日定时同步"今天是否已经跑过"的标记，必须落盘——否则每次重启后端都会清零，
  // 一旦重启时北京时间已过18:30，就会被误判成"今天还没跑过"而立刻重新触发一次
  lastScheduledSyncDate: string | null = null;
  fetchScopeHandlers: ScopeConfigItem[] = [];
  displayCategories: ScopeConfigItem[] = [];
  excludedOwningApps: ScopeConfigItem[] = [];
  excludedStatuses: ScopeConfigItem[] = [];
  verifyTicketCodes: ScopeConfigItem[] = [];
  defectCategories: ScopeConfigItem[] = DEFAULT_DEFECT_CATEGORIES();
  defectTreeNodes: DefectTreeNode[] = [];

  constructor() {
    this.load();
  }

  private load() {
    try {
      if (!fs.existsSync(DATA_FILE)) return;
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")) as Partial<PersistedState>;
      // 历史数据兼容：紧急字段原来是布尔值，现已改为文本输入（空字符串=不紧急）。
      // 旧的 store.json 里存的还是 true/false，不归一的话后续按文本处理会直接抛异常
      this.tickets = (parsed.tickets ?? []).map((t) => ({
        ...t,
        urgent: typeof t.urgent === "string" ? t.urgent : t.urgent ? "紧急" : "",
        // 缺陷跟进字段是后加的，旧 store.json 里没有这几个键，兜底成"未填写"
        hasTestCase: t.hasTestCase ?? null,
        testCaseSupplemented: t.testCaseSupplemented ?? null,
        hasAutomatedTest: t.hasAutomatedTest ?? null,
        automationPlanCompleteTime: t.automationPlanCompleteTime ?? null,
        completionStatus: t.completionStatus ?? "",
        spentHours: t.spentHours ?? null,
      }));
      this.messages = parsed.messages ?? [];
      this.logs = parsed.logs ?? [];
      this.lastUpdateTime = parsed.lastUpdateTime ?? "";
      this.lastScheduledSyncDate = parsed.lastScheduledSyncDate ?? null;

      // 用 ?? 而不是 ||：老版本的 store.json 里没有这两个键（undefined）才回退到 seed 打底；
      // 用户确实在页面上把部门/账号删空的情况下存的是 []，那是有效状态，必须原样保留，
      // 不能又被 seed 数据填回来
      this.departments = parsed.departments ?? DEPARTMENTS;
      this.accounts = parsed.accounts ?? generateAccounts();
      // 老的 store.json 里没有这几个键，回退到空数组＝不限制/不排除，保持升级前的行为
      this.fetchScopeHandlers = parsed.fetchScopeHandlers ?? [];
      this.displayCategories = parsed.displayCategories ?? [];
      this.excludedOwningApps = parsed.excludedOwningApps ?? [];
      this.excludedStatuses = parsed.excludedStatuses ?? [];
      this.verifyTicketCodes = parsed.verifyTicketCodes ?? [];
      // 老的 store.json 里没有这个键（undefined）才用默认的「缺陷」打底；
      // 管理员确实把它删空了存的是 []，那是有效状态（=不限分类），要原样保留
      this.defectCategories = parsed.defectCategories ?? DEFAULT_DEFECT_CATEGORIES();
      // 老数据没有这个键；空数组是有效状态（=按原始形态展示），不能被默认值盖掉
      this.defectTreeNodes = parsed.defectTreeNodes ?? [];

      // 兜底：管理员账号是锁定的、页面上删不掉，但万一落盘数据被手工改坏导致一个管理员都没有，
      // 就会彻底登不进系统、也没有任何入口能把它加回来。这里补一个回去，避免被锁在门外
      if (!this.accounts.some((a) => a.role === "admin")) {
        const seededAdmin = generateAccounts().find((a) => a.role === "admin");
        if (seededAdmin) {
          console.warn("[store] 落盘数据里没有管理员账号，已自动补回默认超级管理员，避免无法登录");
          this.accounts.unshift(seededAdmin);
        }
      }
    } catch (e) {
      console.error(`[store] 读取持久化数据失败（${DATA_FILE}），本次将以空数据启动：`, (e as Error).message);
    }
  }

  // 先写临时文件再原子改名，避免进程被中途杀掉导致 store.json 写到一半、内容损坏
  save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const state: PersistedState = {
        tickets: this.tickets,
        messages: this.messages,
        logs: this.logs,
        lastUpdateTime: this.lastUpdateTime,
        lastScheduledSyncDate: this.lastScheduledSyncDate,
        departments: this.departments,
        accounts: this.accounts,
        fetchScopeHandlers: this.fetchScopeHandlers,
        displayCategories: this.displayCategories,
        excludedOwningApps: this.excludedOwningApps,
        excludedStatuses: this.excludedStatuses,
        verifyTicketCodes: this.verifyTicketCodes,
        defectCategories: this.defectCategories,
        defectTreeNodes: this.defectTreeNodes,
      };
      const tmpFile = `${DATA_FILE}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(state));
      fs.renameSync(tmpFile, DATA_FILE);
    } catch (e) {
      console.error(`[store] 持久化数据失败（${DATA_FILE}）：`, (e as Error).message);
    }
  }

  /**
   * 工单中心与各看板统一的可见数据源，三条范围配置依次收敛（彼此是"与"的关系）：
   *   1. 分类显示范围：只保留配置里的分类
   *   2. 归属应用排除名单：去掉配置里的归属应用
   *   3. 状态排除名单：去掉配置里的状态
   * 列表、统计卡片、导出、首页/开发工时/部门统计都必须用它，
   * 否则会出现"看板数量跟列表对不上"。三项都为空时返回全部。
   */
  get visibleTickets(): Ticket[] {
    const byCategory = applyDisplayScope(this.tickets, this.displayCategories.map((i) => i.value));
    const byApp = applyOwningAppExclusion(byCategory, this.excludedOwningApps.map((i) => i.value));
    return applyStatusExclusion(byApp, this.excludedStatuses.map((i) => i.value));
  }

  // 缺陷跟进页的可见范围：分类换成 defectCategories，其余（归属应用/状态排除）沿用同一套配置。
  // 分类必须走自己这份，否则工单中心一旦配成只看「需求」，缺陷跟进页就一条都剩不下
  get defectVisibleTickets(): Ticket[] {
    const byCategory = applyDisplayScope(this.tickets, this.defectCategories.map((i) => i.value));
    const byApp = applyOwningAppExclusion(byCategory, this.excludedOwningApps.map((i) => i.value));
    return applyStatusExclusion(byApp, this.excludedStatuses.map((i) => i.value));
  }

  getTicket(id: string) {
    return this.tickets.find((t) => t.id === id || t.code === id);
  }

  addChangeLog(ticket: Ticket, entries: ChangeLogEntry[]) {
    ticket.changeHistory.push(...entries);
  }

  addLog(entry: Omit<LogEntry, "id">) {
    const log: LogEntry = { id: uuid(), ...entry };
    this.logs.unshift(log);
    return log;
  }

  addMessage(entry: Omit<InSiteMessage, "id">) {
    const msg: InSiteMessage = { id: uuid(), ...entry };
    this.messages.unshift(msg);
    return msg;
  }
}

// 执行不可逆的批量删除（如"清理当曲云已删除工单"）之前，把整份数据文件另存一份。
// 误删时把这个文件改名回 store.json 就能整体回滚。返回备份文件名，失败返回 null——
// 备份失败不该把主流程也带崩，但要让调用方知道这次没有备份
export function backupStoreFile(): string | null {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `store-backup-${stamp}.json`;
    fs.copyFileSync(DATA_FILE, path.join(DATA_DIR, name));
    return name;
  } catch (e) {
    console.error("[store] 备份数据文件失败：", (e as Error).message);
    return null;
  }
}

// ---- 每日自动备份 ----
// 命名前缀跟上面那个"删除前备份"刻意分开：轮转只清理每日备份，
// store-backup-* 是不可逆删除前的救命副本，一份都不能自动删
const DAILY_BACKUP_PREFIX = "store-daily-";
// 保留份数，默认 7 天。设成 1 以下没有意义，兜底拉回 1
const DAILY_BACKUP_KEEP = Math.max(1, Number(process.env.STORE_BACKUP_KEEP ?? 7));

/**
 * 生成当天的数据备份（已有则跳过），并按保留份数清理旧的。
 * 返回新生成的文件名；跳过或失败返回 null。
 */
export function runDailyBackup(dateStr: string): string | null {
  try {
    if (!fs.existsSync(DATA_FILE)) return null;
    // 工单为空时绝不备份：load() 出错会以空数据启动（见 load 的 catch），
    // 这时候备份等于把一份空文件存进来，还会把之前的好备份挤出保留窗口
    if (!store.tickets.length) return null;

    const name = `${DAILY_BACKUP_PREFIX}${dateStr}.json`;
    const target = path.join(DATA_DIR, name);
    if (fs.existsSync(target)) return null; // 今天已经备份过了

    fs.copyFileSync(DATA_FILE, target);
    pruneDailyBackups();
    return name;
  } catch (e) {
    console.error("[store] 每日备份失败：", (e as Error).message);
    return null;
  }
}

// 文件名里的日期是 YYYY-MM-DD 定长格式，字典序即时间序，直接排序取最旧的删
function pruneDailyBackups() {
  const files = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith(DAILY_BACKUP_PREFIX) && f.endsWith(".json"))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - DAILY_BACKUP_KEEP))) {
    fs.unlinkSync(path.join(DATA_DIR, f));
  }
}

export const store = new Store();
export type { SyncJob };
