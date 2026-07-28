import { create } from "zustand";

// "切换人员"功能：选择要查看哪些 IT 受理人负责的工单（不同于管理员的身份切换，不改变登录身份）。
// 支持多选；空数组表示不限人员，即"所有工单"。选中结果会直接作用到工单列表的筛选上
interface ViewTargetState {
  targets: string[];
  setTargets: (t: string[]) => void;
}

export const useViewTargetStore = create<ViewTargetState>((set) => ({
  targets: [],
  setTargets: (t) => set({ targets: t }),
}));
