import { useState } from "react";
import { Button, Dropdown, Popover, Progress, Space, Tag, message } from "antd";
import { CloudSyncOutlined, DownOutlined } from "@ant-design/icons";
import type { MenuProps } from "antd";
import { useSync } from "../hooks/useSync";
import { useFilteredTicketsStore } from "../store/filteredTickets";

export default function UpdateTicketsButton({ onRefresh }: { onRefresh: () => void }) {
  const { job, lastUpdateTime, busy, fetchNew, updateTickets, syncTapd, terminate } = useSync(onRefresh);
  const { filters } = useFilteredTicketsStore();
  const [progressOpen, setProgressOpen] = useState(false);

  async function handleFetchNew(mode: "incremental" | "full") {
    setProgressOpen(true);
    try {
      const result = await fetchNew(mode);
      message.success(
        `${mode === "full" ? "全量获取" : "获取新工单"}完成，新增 ${result?.addedCount ?? 0} 条，更新异常 ${
          result?.failedCount ?? 0
        } 条`
      );
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "获取新工单失败");
    }
  }

  async function handleUpdate() {
    setProgressOpen(true);
    try {
      await updateTickets(filters);
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "更新工单失败");
    }
  }

  async function handleTapd() {
    setProgressOpen(true);
    try {
      await syncTapd(filters);
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "获取TAPD信息失败");
    }
  }

  const progressPercent = job && job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;
  const jobLabel =
    job?.type === "update_tickets"
      ? "更新工单"
      : job?.type === "sync_tapd"
      ? "获取TAPD信息"
      : job?.type === "fetch_new"
      ? "获取新工单"
      : "";

  const progressContent = (
    <div style={{ width: 280 }}>
      {job ? (
        <>
          <div style={{ marginBottom: 8, fontWeight: 500 }}>
            {jobLabel} {job.status === "running" ? "进行中" : job.status === "done" ? "已完成" : "已终止"}
          </div>
          <Progress
            percent={progressPercent}
            status={job.status === "running" ? "active" : job.failed ? "exception" : "success"}
          />
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

  const items: MenuProps["items"] = [
    { key: "fetch-incremental", label: "获取新工单" },
    { key: "fetch-full", label: "全量获取（用于数据初始化）" },
    { key: "update", label: "更新工单（按当前筛选）" },
    { key: "tapd", label: "获取TAPD信息（按当前筛选）" },
    { key: "abnormal", label: "获取异常数据（需求待确认）", disabled: true },
  ];

  const onMenuClick: MenuProps["onClick"] = ({ key }) => {
    if (key === "fetch-incremental") handleFetchNew("incremental");
    else if (key === "fetch-full") handleFetchNew("full");
    else if (key === "update") handleUpdate();
    else if (key === "tapd") handleTapd();
  };

  return (
    <Space size={8}>
      <Dropdown menu={{ items, onClick: onMenuClick }} trigger={["click"]}>
        <Button icon={<CloudSyncOutlined />} loading={busy}>
          更新工单 <DownOutlined />
        </Button>
      </Dropdown>
      {job && (
        <Popover
          content={progressContent}
          open={progressOpen}
          onOpenChange={setProgressOpen}
          trigger="click"
          placement="bottomRight"
        >
          <Tag
            color={job.status === "running" ? "processing" : job.failed ? "error" : "success"}
            style={{ cursor: "pointer" }}
          >
            {jobLabel} {job.status === "running" ? `${job.processed}/${job.total}` : job.status === "done" ? "已完成" : "已终止"}
          </Tag>
        </Popover>
      )}
    </Space>
  );
}
