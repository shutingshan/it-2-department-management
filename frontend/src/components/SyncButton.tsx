import { useRef, useState } from "react";
import { Button, Popover, Progress, Space, message, Tag } from "antd";
import { CloudSyncOutlined, DownloadOutlined } from "@ant-design/icons";
import { useSync } from "../hooks/useSync";

export default function SyncButton({ onRefresh }: { onRefresh: () => void }) {
  const { job, lastUpdateTime, busy, fetchNew, updateTickets, syncTapd, terminate } = useSync(onRefresh);
  const [open, setOpen] = useState(false);

  async function handleFetchNew() {
    try {
      const count = await fetchNew();
      message.success(`获取新工单完成，新增 ${count ?? 0} 条`);
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "获取新工单失败");
    }
  }

  async function handleUpdate() {
    setOpen(true);
    try {
      await updateTickets();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "更新工单失败");
      return;
    }
  }

  // 更新工单完成后自动触发同步 TAPD
  const triggeredRef = useRef(false);
  if (job && job.type === "update_tickets" && job.status === "done" && !triggeredRef.current) {
    triggeredRef.current = true;
    syncTapd();
  }
  if (job && job.status === "running") {
    triggeredRef.current = false;
  }

  const progressPercent = job && job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;

  const jobLabel =
    job?.type === "update_tickets" ? "更新工单" : job?.type === "sync_tapd" ? "同步 TAPD" : "";

  const content = (
    <div style={{ width: 280 }}>
      {job ? (
        <>
          <div style={{ marginBottom: 8, fontWeight: 500 }}>
            {jobLabel} {job.status === "running" ? "进行中" : job.status === "done" ? "已完成" : "已终止"}
          </div>
          <Progress percent={progressPercent} status={job.status === "running" ? "active" : job.failed ? "exception" : "success"} />
          <Space style={{ marginTop: 8 }}>
            <Tag color="green">成功 {job.success}</Tag>
            <Tag color="red">失败 {job.failed}</Tag>
            <Tag>{job.processed}/{job.total}</Tag>
          </Space>
          {job.status === "running" && (
            <div style={{ marginTop: 8 }}>
              <Button danger size="small" onClick={() => terminate()}>
                终止任务
              </Button>
            </div>
          )}
          {job.failReasons.length > 0 && (
            <div style={{ marginTop: 8, maxHeight: 120, overflow: "auto", fontSize: 12, color: "#f5222d" }}>
              {job.failReasons.slice(0, 5).map((r, i) => (
                <div key={i}>{r}</div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div style={{ color: "#8c8c8c" }}>暂无同步任务</div>
      )}
      <div style={{ marginTop: 8, fontSize: 12, color: "#8c8c8c" }}>更新时间：{lastUpdateTime || "-"}</div>
    </div>
  );

  return (
    <Space size={4}>
      <Button icon={<DownloadOutlined />} onClick={handleFetchNew} loading={busy && !job}>
        获取新工单
      </Button>
      <Popover content={content} open={open} onOpenChange={setOpen} trigger="click" placement="bottomRight">
        <Button icon={<CloudSyncOutlined />} onClick={handleUpdate} loading={busy}>
          更新工单
        </Button>
      </Popover>
    </Space>
  );
}
