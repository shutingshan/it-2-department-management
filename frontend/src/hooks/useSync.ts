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
      // 真实抓取当曲云需要打开浏览器、登录、逐页拉全量数据，单页最长可能等 4 分钟、
      // 翻页可能有几十页，整体耗时可能远超 5 分钟；超时设置太短会导致客户端先放弃，
      // 而后端仍在继续跑，用户重新点击又会撞上并发锁，所以这里放宽到 30 分钟
      const res = await api.post(
        "/sync/fetch-new",
        { actor: user.name, mode },
        { timeout: 1800000 }
      );
      setJob(res.data.job);
      onRefresh?.();
      return res.data as { addedCount: number; updatedCount: number; failedCount: number; failReasons: string[] };
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
