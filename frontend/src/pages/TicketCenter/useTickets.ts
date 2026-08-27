import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import type { Ticket } from "../../api/types";
import { useAuthStore } from "../../store/auth";

export interface TicketFilters {
  search?: string;
  submittedFrom?: string;
  submittedTo?: string;
  stage?: string[];
  status?: string[];
  urgent?: boolean; // 筛选口径：true=紧急字段有值，false=无值
  hasTapd?: boolean;
  monthlyPlan?: string[];
  expectedMonth?: string[];
  iteration?: string[];
  owningApp?: string[];
  category?: string[];
  requesterDept?: string[];
  requester?: string[];
  watcher?: string[];
  itHandler?: string[];
  cardKey?: string;
  sortField?: string;
  sortOrder?: "asc" | "desc";
  // "defect"=走缺陷跟进的分类范围配置；不传则走工单中心那份
  scope?: "defect";
  // 缺陷跟进页的人工维护字段。三态字段取值为 yes / no / __empty__（未填写）
  hasTestCase?: string[];
  testCaseSupplemented?: string[];
  hasAutomatedTest?: string[];
  completionStatus?: string[];
  automationFrom?: string;
  automationTo?: string;
  spentHoursMin?: number;
  spentHoursMax?: number;
}

// 「未填写」在筛选参数里的表示，跟后端 filter.ts 的 EMPTY_TOKEN 保持一致
export const EMPTY_TOKEN = "__empty__";

export interface Facets {
  requesters: string[];
  watchers: string[];
  itHandlers: string[];
  developers: string[];
  monthlyPlans: string[];
  expectedMonths: string[];
  iterations: string[];
  owningApps: string[];
  categories: string[];
}

const EMPTY_FACETS: Facets = {
  requesters: [],
  watchers: [],
  itHandlers: [],
  developers: [],
  monthlyPlans: [],
  expectedMonths: [],
  iterations: [],
  owningApps: [],
  categories: [],
};

export function useTickets(filters: TicketFilters, page: number, pageSize: number, refreshKey: number) {
  const { user } = useAuthStore();
  const [data, setData] = useState<Ticket[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<Facets>(EMPTY_FACETS);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, unknown> = {
        ...filters,
        page,
        pageSize,
        actor: user?.name,
        actorRole: user?.role,
      };
      const res = await api.get("/tickets", { params });
      setData(res.data.data);
      setTotal(res.data.total);
      setFacets(res.data.facets);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filters), page, pageSize, refreshKey]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, total, facets, loading, reload: load };
}
