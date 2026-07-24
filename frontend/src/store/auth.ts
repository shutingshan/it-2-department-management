import { create } from "zustand";
import type { User } from "../api/types";

const SESSION_KEY = "itc_session_user";
const REMEMBER_KEY = "itc_remember_account";

interface AuthState {
  user: User | null;
  setUser: (u: User | null) => void;
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

export const useAuthStore = create<AuthState>((set) => ({
  user: loadSessionUser(),
  setUser: (u) => {
    if (u) localStorage.setItem(SESSION_KEY, JSON.stringify(u));
    else localStorage.removeItem(SESSION_KEY);
    set({ user: u });
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
