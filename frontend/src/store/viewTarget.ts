import { create } from "zustand";

// "切换人员"功能：选择要查看谁的工单（不同于管理员的身份切换，不改变登录身份）
// target 为 null 表示未手动选择，默认展示当前登录人自己的工单
// target 为 "ALL" 表示查看二部全部工单
export const ALL_TICKETS_TARGET = "ALL";

interface ViewTargetState {
  target: string | null;
  setTarget: (t: string | null) => void;
}

export const useViewTargetStore = create<ViewTargetState>((set) => ({
  target: null,
  setTarget: (t) => set({ target: t }),
}));
