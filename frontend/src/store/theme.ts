import { create } from "zustand";

export type ThemeMode = "light" | "dark";

const STORAGE_KEY = "app-theme-mode";

function loadMode(): ThemeMode {
  // 默认浅色（当前这套皮肤），只有用户明确切换过深色才用深色
  return localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
}

// 自定义 CSS 靠 html 上的 data-theme 切换配色变量（见 index.css），
// antd 组件则走 ConfigProvider 的算法（见 ThemeProvider），两边由这里统一驱动
function applyMode(mode: ThemeMode) {
  document.documentElement.dataset.theme = mode;
}

interface ThemeState {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  toggle: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: loadMode(),
  setMode: (mode) => {
    localStorage.setItem(STORAGE_KEY, mode);
    applyMode(mode);
    set({ mode });
  },
  toggle: () => get().setMode(get().mode === "dark" ? "light" : "dark"),
}));

// 首屏就把 data-theme 落到 html 上，避免刷新后闪一下浅色再变深色
applyMode(useThemeStore.getState().mode);
