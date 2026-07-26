import { v4 as uuid } from "uuid";
import { DEPARTMENTS, USERS, generateAccounts } from "./seed";
import { Account, ChangeLogEntry, InSiteMessage, LogEntry, Ticket } from "./types";

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
  // 工单/处理记录/站内信/同步日志均为真实数据，不再生成模拟数据；
  // 人员/部门/账号配置保留，保证系统登录与人员目录不受影响
  tickets: Ticket[] = [];
  departments = DEPARTMENTS;
  users = USERS;
  accounts: Account[] = generateAccounts();
  messages: InSiteMessage[] = [];
  logs: LogEntry[] = [];
  lastUpdateTime = "";
  currentJob: SyncJob | null = null;

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
