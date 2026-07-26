import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import { DEPARTMENTS, USERS, generateAccounts } from "./seed";
import { Account, ChangeLogEntry, InSiteMessage, LogEntry, Ticket } from "./types";

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
  // 人员/部门/账号配置保留，保证系统登录与人员目录不受影响
  tickets: Ticket[] = [];
  departments = DEPARTMENTS;
  users = USERS;
  accounts: Account[] = generateAccounts();
  messages: InSiteMessage[] = [];
  logs: LogEntry[] = [];
  lastUpdateTime = "";
  currentJob: SyncJob | null = null;

  constructor() {
    this.load();
  }

  private load() {
    try {
      if (!fs.existsSync(DATA_FILE)) return;
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")) as Partial<PersistedState>;
      this.tickets = parsed.tickets ?? [];
      this.messages = parsed.messages ?? [];
      this.logs = parsed.logs ?? [];
      this.lastUpdateTime = parsed.lastUpdateTime ?? "";
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
