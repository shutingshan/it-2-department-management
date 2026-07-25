import { create } from "zustand";
import type { TicketFilters } from "../pages/TicketCenter/useTickets";

// 供"更新工单"下拉菜单读取工单中心当前筛选条件，用于按筛选范围调用后端接口
interface FilteredTicketsState {
  filters: TicketFilters;
  setFilters: (f: TicketFilters) => void;
}

export const useFilteredTicketsStore = create<FilteredTicketsState>((set) => ({
  filters: {},
  setFilters: (f) => set({ filters: f }),
}));
