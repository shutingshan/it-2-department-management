import { useState } from "react";
import { AutoComplete, Button, Dropdown, Modal, Popover, Progress, Space, Tag, message } from "antd";
import { CloudSyncOutlined, DownOutlined } from "@ant-design/icons";
import type { MenuProps } from "antd";
import { api } from "../api/client";
import { useSync } from "../hooks/useSync";
import { useAuthStore } from "../store/auth";
import { useFilteredTicketsStore } from "../store/filteredTickets";

export default function UpdateTicketsButton({ onRefresh }: { onRefresh: () => void }) {
  const { job, lastUpdateTime, busy, fetchNew, updateTickets, syncTapd, terminate } = useSync(onRefresh);
  const { user } = useAuthStore();
  const { filters } = useFilteredTicketsStore();
  const [progressOpen, setProgressOpen] = useState(false);
  const [tapdModalOpen, setTapdModalOpen] = useState(false);
  const [tapdCode, setTapdCode] = useState<string | undefined>(undefined);
  const [tapdCodeOptions, setTapdCodeOptions] = useState<string[]>([]);
  const [singleSyncing, setSingleSyncing] = useState(false);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [loginStarting, setLoginStarting] = useState(false);
  const [loginConfirming, setLoginConfirming] = useState(false);

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

  // TAPD扫码登录：先让后端弹出浏览器窗口，用户在窗口里扫码登录完成后，回到这个弹窗点确定保存登录态
  async function handleTapdLogin() {
    setLoginStarting(true);
    try {
      // 打开窗口要先加载TAPD首页，比较慢，给足超时
      await api.post("/sync/tapd-login/start", {}, { timeout: 600000 });
      setLoginModalOpen(true);
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "打开TAPD登录窗口失败");
    } finally {
      setLoginStarting(false);
    }
  }

  async function handleTapdLoginConfirm() {
    setLoginConfirming(true);
    try {
      await api.post("/sync/tapd-login/confirm", { actor: user?.name });
      setLoginModalOpen(false);
      message.success("TAPD登录态已保存，之后同步不需要再扫码");
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "保存TAPD登录态失败");
    } finally {
      setLoginConfirming(false);
    }
  }

  async function handleTapdLoginCancel() {
    setLoginModalOpen(false);
    await api.post("/sync/tapd-login/cancel", {}).catch(() => {});
  }

  function openTapdModal() {
    setTapdCode(undefined);
    setTapdModalOpen(true);
    api.get("/tickets/codes").then((res) => setTapdCodeOptions(res.data.data));
  }

  // 弹窗里录入了工单编号：只获取这一条工单的TAPD信息；不录入：按当前筛选批量获取（原有逻辑）
  async function handleTapdModalOk() {
    const code = tapdCode?.trim();
    setTapdModalOpen(false);
    if (!code) {
      await handleTapd();
      return;
    }
    setSingleSyncing(true);
    try {
      const res = await api.post(`/sync/tapd/${encodeURIComponent(code)}`, { actor: user?.name });
      const missing: string[] = res.data?.missingFields ?? [];
      if (missing.length) {
        message.warning(`工单 ${code} 已同步，但未获取到：${missing.join("、")}`, 6);
      } else {
        message.success(`工单 ${code} 的TAPD信息已同步`);
      }
      onRefresh();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "获取TAPD信息失败");
    } finally {
      setSingleSyncing(false);
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

  const jobRunning = busy || job?.status === "running" || singleSyncing;
  const items: MenuProps["items"] = [
    { key: "fetch-incremental", label: "获取新工单", disabled: jobRunning },
    { key: "fetch-full", label: "全量获取（用于数据初始化）", disabled: jobRunning },
    { key: "update", label: "更新工单（按当前筛选）", disabled: jobRunning },
    { key: "tapd", label: "获取TAPD信息（按当前筛选）", disabled: jobRunning },
    { key: "tapd-login", label: "TAPD扫码登录", disabled: jobRunning },
    { key: "abnormal", label: "获取异常数据（需求待确认）", disabled: true },
  ];

  const onMenuClick: MenuProps["onClick"] = ({ key }) => {
    if (key === "fetch-incremental") handleFetchNew("incremental");
    else if (key === "fetch-full") handleFetchNew("full");
    else if (key === "update") handleUpdate();
    else if (key === "tapd") openTapdModal();
    else if (key === "tapd-login") handleTapdLogin();
  };

  return (
    <Space size={8}>
      <Dropdown menu={{ items, onClick: onMenuClick }} trigger={["click"]}>
        <Button icon={<CloudSyncOutlined />} loading={busy || singleSyncing || loginStarting}>
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

      <Modal
        title="获取TAPD信息"
        open={tapdModalOpen}
        onCancel={() => setTapdModalOpen(false)}
        onOk={handleTapdModalOk}
        okText="确定"
        cancelText="取消"
      >
        <div style={{ marginBottom: 8 }}>工单编号（可选，不填则按当前筛选条件批量获取）</div>
        <AutoComplete
          style={{ width: "100%" }}
          value={tapdCode}
          onChange={setTapdCode}
          options={tapdCodeOptions.map((c) => ({ value: c }))}
          placeholder="可输入或选择工单编号，只获取这一条；留空则批量获取"
          allowClear
          filterOption={(input, option) => (option?.value as string)?.toLowerCase().includes(input.toLowerCase())}
        />
      </Modal>

      <Modal
        title="TAPD扫码登录"
        open={loginModalOpen}
        onCancel={handleTapdLoginCancel}
        onOk={handleTapdLoginConfirm}
        okText="我已完成登录，保存登录态"
        cancelText="取消"
        confirmLoading={loginConfirming}
        maskClosable={false}
        width={520}
      >
        <p>已弹出一个浏览器窗口并停在 TAPD 首页，请在那个窗口里完成登录（可能需要先点"登录"按钮才会出现二维码，再用手机扫码）。</p>
        <p>登录成功、能看到 TAPD 工作台后，回到这里点击下方按钮保存登录态；之后的同步会直接复用，不需要再扫码。</p>
        <p style={{ color: "#8c8c8c", fontSize: 12, marginBottom: 0 }}>
          注意：浏览器窗口是在运行后端服务的那台机器上弹出的。超过15分钟未确认会自动关闭，需要重新发起。
        </p>
      </Modal>
    </Space>
  );
}
