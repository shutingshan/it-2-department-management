import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import { DEPARTMENTS, USERS, generateAccounts } from "./seed";
import { Account, ChangeLogEntry, Department, InSiteMessage, LogEntry, Ticket } from "./types";

// 工单/处理记录/站内信/同步日志是真实业务数据（不是每次启动都重新生成的模拟数据），
// 必须落盘持久化，否则进程一重启（比如 ts-node-dev 检测到文件变化自动重启）就会全部丢失。
// 现阶段没有引入真正的数据库，先用一份 JSON 文件做最简单的持久化：定时落盘 + 进程退出前落盘
const DATA_DIR = path.join(__dirname, "../data");
const DATA_FILE = path.join(DATA_DIR, "store.json");

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
  users = USERS;
  accounts: Account[] = generateAccounts();
  messages: InSiteMessage[] = [];
  logs: LogEntry[] = [];
  lastUpdateTime = "";
  currentJob: SyncJob | null = null;
  // 每日定时同步"今天是否已经跑过"的标记，必须落盘——否则每次重启后端都会清零，
  // 一旦重启时北京时间已过18:30，就会被误判成"今天还没跑过"而立刻重新触发一次
  lastScheduledSyncDate: string | null = null;

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
      };
      const tmpFile = `${DATA_FILE}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(state));
      fs.renameSync(tmpFile, DATA_FILE);
    } catch (e) {
      console.error(`[store] 持久化数据失败（${DATA_FILE}）：`, (e as Error).message);
    }
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

export const store = new Store();
export type { SyncJob };
