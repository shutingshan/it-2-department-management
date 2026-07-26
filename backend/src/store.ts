import dayjs from "dayjs";
import { v4 as uuid } from "uuid";
import { DEPARTMENTS, USERS, generateAccounts, generateLogs, generateMessages, generateTickets } from "./seed";
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
  tickets: Ticket[] = generateTickets();
  departments = DEPARTMENTS;
  users = USERS;
  accounts: Account[] = generateAccounts();
  messages: InSiteMessage[] = generateMessages(this.tickets);
  logs: LogEntry[] = generateLogs();
  lastUpdateTime: string = dayjs("2026-07-24 08:00").format("YYYY-MM-DD HH:mm:ss");
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
