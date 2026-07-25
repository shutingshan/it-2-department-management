import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { SyncJob } from "../api/types";
import { useAuthStore } from "../store/auth";
import { ROLE_LABELS } from "../api/types";
import type { TicketFilters } from "../pages/TicketCenter/useTickets";

export function useSync(onRefresh?: () => void) {
  const { user } = useAuthStore();
  const [job, setJob] = useState<SyncJob | null>(null);
  const [lastUpdateTime, setLastUpdateTime] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const poll = useCallback(
    (onDone?: () => void) => {
      stopPoll();
      pollRef.current = window.setInterval(async () => {
        const res = await api.get("/sync/status");
        setJob(res.data.job);
        setLastUpdateTime(res.data.lastUpdateTime);
        if (res.data.job && res.data.job.status !== "running") {
          stopPoll();
          onDone?.();
        }
      }, 500);
    },
    [stopPoll]
  );

  useEffect(() => {
    api.get("/sync/status").then((res) => setLastUpdateTime(res.data.lastUpdateTime));
    return () => stopPoll();
  }, [stopPoll]);

  async function fetchNew(mode: "incremental" | "full" = "incremental") {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      // 真实抓取当曲云需要打开浏览器、登录、翻页拉全量数据，可能耗时几分钟，单独放宽超时
      const res = await api.post(
        "/sync/fetch-new",
        { actor: user.name, mode },
        { timeout: 300000 }
      );
      onRefresh?.();
      return res.data.addedCount as number;
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "获取新工单失败");
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function updateTickets(filters?: TicketFilters) {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post("/sync/update-tickets", {
        actor: user.name,
        actorRole: user.role,
        filters,
      });
      setJob(res.data.job);
      poll(() => {
        onRefresh?.();
      });
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "更新工单失败");
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function syncTapd(filters?: TicketFilters) {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post("/sync/tapd", { actor: user.name, filters });
      setJob(res.data.job);
      poll(() => onRefresh?.());
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "获取 TAPD 信息失败");
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function terminate() {
    if (!user) return;
    await api.post("/sync/terminate", { actor: user.name });
    stopPoll();
    const res = await api.get("/sync/status");
    setJob(res.data.job);
  }

  return { job, lastUpdateTime, busy, error, fetchNew, updateTickets, syncTapd, terminate, roleLabel: user ? ROLE_LABELS[user.role] : "" };
}
