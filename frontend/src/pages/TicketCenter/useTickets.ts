import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import type { Ticket } from "../../api/types";

export interface TicketFilters {
  search?: string;
  submittedFrom?: string;
  submittedTo?: string;
  stage?: string[];
  status?: string[];
  urgent?: boolean;
  hasTapd?: boolean;
  monthlyPlan?: string[];
  iteration?: string[];
  owningApp?: string[];
  requesterDept?: string[];
  requester?: string[];
  watcher?: string[];
  itHandler?: string[];
  sortField?: string;
  sortOrder?: "asc" | "desc";
}

export interface Facets {
  requesters: string[];
  watchers: string[];
  itHandlers: string[];
  developers: string[];
  monthlyPlans: string[];
  iterations: string[];
  owningApps: string[];
}

const EMPTY_FACETS: Facets = {
  requesters: [],
  watchers: [],
  itHandlers: [],
  developers: [],
  monthlyPlans: [],
  iterations: [],
  owningApps: [],
};

export function useTickets(filters: TicketFilters, page: number, pageSize: number, refreshKey: number) {
  const [data, setData] = useState<Ticket[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<Facets>(EMPTY_FACETS);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, unknown> = { ...filters, page, pageSize };
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
