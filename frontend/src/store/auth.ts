import { create } from "zustand";
import { api } from "../api/client";
import type { User } from "../api/types";

const SESSION_KEY = "itc_session_user";
const REMEMBER_KEY = "itc_remember_account";

interface AuthState {
  user: User | null;
  setUser: (u: User | null) => void;
  /** 用后端最新的账号信息刷新本地会话，见下方 refreshSession 说明 */
  refreshSession: () => Promise<void>;
  logout: () => void;
  rememberedAccount: string;
  setRememberedAccount: (account: string, remember: boolean) => void;
}

function loadSessionUser(): User | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: loadSessionUser(),
  setUser: (u) => {
    if (u) localStorage.setItem(SESSION_KEY, JSON.stringify(u));
    else localStorage.removeItem(SESSION_KEY);
    set({ user: u });
  },
  /**
   * 会话信息只在登录时下发一次并存进 localStorage，之后不会自己更新。
   * 后端给会话加字段（如 syncPermissions）或管理员改了账号的角色/权限时，
   * 已经登录着的人不重新登录就一直用着旧数据——曾导致加权限字段后，
   * 老会话的管理员本地没有该字段，"更新工单"整个入口被判成没授权而消失。
   * 因此进入应用时按登录账号回查一次，用后端的最新结果覆盖本地会话。
   */
  refreshSession: async () => {
    const current = get().user;
    if (!current) return;
    try {
      const res = await api.get("/auth/me", { params: { userId: current.id } });
      const latest = res.data.user as User;
      localStorage.setItem(SESSION_KEY, JSON.stringify(latest));
      set({ user: latest });
    } catch (e: any) {
      // 账号已被删除或取消授权：清掉本地会话，回到登录页重新登录
      if (e?.response?.status === 404) {
        localStorage.removeItem(SESSION_KEY);
        set({ user: null });
      }
      // 其余情况（断网、后端重启中等）保留本地会话，不因为一次请求失败就把人踢下线
    }
  },
  logout: () => {
    localStorage.removeItem(SESSION_KEY);
    set({ user: null });
  },
  rememberedAccount: localStorage.getItem(REMEMBER_KEY) ?? "",
  setRememberedAccount: (account, remember) => {
    if (remember) {
      localStorage.setItem(REMEMBER_KEY, account);
    } else {
      localStorage.removeItem(REMEMBER_KEY);
    }
    set({ rememberedAccount: remember ? account : "" });
  },
}));
