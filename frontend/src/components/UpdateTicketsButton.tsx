import { useState } from "react";
import { AutoComplete, Button, Dropdown, Modal, Popover, Progress, Space, Tag, message } from "antd";
import { CloudSyncOutlined, DownOutlined } from "@ant-design/icons";
import type { MenuProps } from "antd";
import { api } from "../api/client";
import { SYNC_PERMISSIONS } from "../api/types";
import { useSync } from "../hooks/useSync";
import { useAuthStore } from "../store/auth";
import { useFilteredTicketsStore } from "../store/filteredTickets";

export default function UpdateTicketsButton({ onRefresh }: { onRefresh: () => void }) {
  const { job, lastUpdateTime, busy, fetchNew, updateTickets, syncTapd, terminate } = useSync(onRefresh);
  const { user } = useAuthStore();
  const { filters } = useFilteredTicketsStore();
  const [progressOpen, setProgressOpen] = useState(false);
  const [tapdModalOpen, setTapdModalOpen] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [tapdCode, setTapdCode] = useState<string | undefined>(undefined);
  const [tapdCodeOptions, setTapdCodeOptions] = useState<string[]>([]);
  const [singleSyncing, setSingleSyncing] = useState(false);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [loginStarting, setLoginStarting] = useState(false);
  const [loginConfirming, setLoginConfirming] = useState(false);
  // 本次扫码登录是由哪次"获取TAPD信息"触发的（code 为 null 表示批量）：登录完成后自动接着跑；
  // 为 null 表示是用户从菜单里主动发起的登录，登录完就结束、不接着获取
  const [pendingTapdCode, setPendingTapdCode] = useState<{ code: string | null } | null>(null);

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

  // 后端在"需要扫码登录"时统一返回 409 + needLogin，跟其他失败区分开
  const isNeedLogin = (e: any) => e?.response?.status === 409 && e?.response?.data?.needLogin;

  // 真正发起获取：code 为 null 表示按当前筛选批量获取，否则只获取这一条。
  // 需要登录时不在这里提示，返回 needLogin 交给上层决定是引导登录还是直接报错
  async function runTapdSync(code: string | null): Promise<{ needLogin: boolean }> {
    if (!code) {
      setProgressOpen(true);
      try {
        await syncTapd(filters);
      } catch (e: any) {
        if (isNeedLogin(e)) return { needLogin: true };
        message.error(e?.response?.data?.message ?? "获取TAPD信息失败");
      }
      return { needLogin: false };
    }

    setSingleSyncing(true);
    try {
      // 单条同步要走完整的登录检查+跳转列表+进详情+等内容加载，可能要好几分钟，
      // 用 client 里 15 秒的默认超时会在后端还正常跑着的时候就先放弃
      const res = await api.post(
        `/sync/tapd/${encodeURIComponent(code)}`,
        { actor: user?.name },
        { timeout: 3600000 }
      );
      const missing: string[] = res.data?.missingFields ?? [];
      if (missing.length) {
        message.warning(`工单 ${code} 已同步，但未获取到：${missing.join("、")}`, 6);
      } else {
        message.success(`工单 ${code} 的TAPD信息已同步`);
      }
      onRefresh();
    } catch (e: any) {
      if (isNeedLogin(e)) return { needLogin: true };
      message.error(e?.response?.data?.message ?? "获取TAPD信息失败");
    } finally {
      setSingleSyncing(false);
    }
    return { needLogin: false };
  }

  // 获取TAPD信息的总入口：需要登录就先引导扫码登录，登录完成后自动重试本次获取；
  // 重试时仍提示需要登录（说明并没有真的登录成功），就直接报错，不再无限引导下去
  async function startTapdSync(code: string | null, isRetry = false) {
    const { needLogin } = await runTapdSync(code);
    if (!needLogin) return;
    if (isRetry) {
      message.error("TAPD 仍未登录，请确认已在弹出的浏览器窗口中完成扫码登录后再试");
      return;
    }
    setPendingTapdCode({ code });
    await handleTapdLogin();
  }

  // TAPD扫码登录：先让后端弹出浏览器窗口，用户在窗口里扫码登录完成后，回到这个弹窗点确定保存登录态
  async function handleTapdLogin() {
    setLoginStarting(true);
    try {
      // 打开窗口要先加载TAPD首页，比较慢，给足超时
      // 带上操作人：后端要据此校验该账号是否被授权做 TAPD 扫码登录
      await api.post("/sync/tapd-login/start", { actor: user?.name }, { timeout: 600000 });
      setLoginModalOpen(true);
    } catch (e: any) {
      setPendingTapdCode(null);
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
      // 这次登录是由"获取TAPD信息"触发的：登录完接着把那次获取跑起来
      const pending = pendingTapdCode;
      setPendingTapdCode(null);
      if (pending) await startTapdSync(pending.code, true);
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "保存TAPD登录态失败");
    } finally {
      setLoginConfirming(false);
    }
  }

  async function handleTapdLoginCancel() {
    setLoginModalOpen(false);
    setPendingTapdCode(null);
    await api.post("/sync/tapd-login/cancel", {}).catch(() => {});
  }

  function openTapdModal() {
    setTapdCode(undefined);
    setTapdModalOpen(true);
    api.get("/tickets/codes").then((res) => setTapdCodeOptions(res.data.data));
  }

  // 弹窗里录入了工单编号：只获取这一条工单的TAPD信息；不录入：按当前筛选批量获取
  async function handleTapdModalOk() {
    const code = tapdCode?.trim() || null;
    setTapdModalOpen(false);
    await startTapdSync(code);
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
            // 抓取阶段拿不到总数，用不确定进度条，避免一直显示 0% 让人以为卡死
            status={job.status === "running" ? "active" : job.failed ? "exception" : "success"}
            showInfo={job.total > 0}
          />
          <Space style={{ marginTop: 8 }}>
            <Tag color="green">成功 {job.success}</Tag>
            <Tag color="red">失败 {job.failed}</Tag>
            <Tag>{job.processed}/{job.total}</Tag>
          </Space>
          {job.status === "running" && (
            <div style={{ marginTop: 8 }}>
              <Button danger size="small" loading={terminating} onClick={handleTerminate}>
                结束进程
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

  async function handleTerminate() {
    setTerminating(true);
    try {
      await terminate();
      message.success("已发出终止指令");
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "终止失败");
    } finally {
      setTerminating(false);
    }
  }

  const jobRunning = busy || job?.status === "running" || singleSyncing;
  // 只展示该账号被授权的操作。这只是体验层面的隐藏，
  // 真正的拦截在后端 assertSyncPermission，直接调接口同样会被 403 挡掉。
  // 管理员按角色直接放行，跟后端 assertSyncPermission 的判断保持一致：
  // syncPermissions 是后来才加的字段，只在登录接口下发，光看这个字段会把
  // 加字段之前就登录着、本地缓存里没有该字段的管理员整个入口隐藏掉
  const isAdmin = user?.role === "admin";
  const granted = isAdmin ? SYNC_PERMISSIONS.map((p) => p.key) : user?.syncPermissions ?? [];
  const allow = (key: string) => granted.includes(key as (typeof granted)[number]);
  const items: MenuProps["items"] = [
    { key: "fetch-incremental", label: "获取新工单", disabled: jobRunning },
    { key: "fetch-full", label: "全量获取（用于数据初始化）", disabled: jobRunning },
    { key: "update", label: "更新工单（按当前筛选）", disabled: jobRunning },
    { key: "tapd", label: "获取TAPD信息（按当前筛选）", disabled: jobRunning },
    { key: "tapd-login", label: "TAPD扫码登录", disabled: jobRunning },
    { key: "abnormal", label: "获取异常数据（需求待确认）", disabled: true },
  ].filter((it) => it.key === "abnormal" || allow(it.key));

  const onMenuClick: MenuProps["onClick"] = ({ key }) => {
    if (key === "fetch-incremental") handleFetchNew("incremental");
    else if (key === "fetch-full") handleFetchNew("full");
    else if (key === "update") handleUpdate();
    else if (key === "tapd") openTapdModal();
    else if (key === "tapd-login") handleTapdLogin();
  };

  // 运行中/刚结束的任务指示器。它不受同步权限影响：任何人都该看得到系统正在跑批，
  // 点开是进度小窗口，里面带「终止任务」。抓取期间 total 还不知道（要翻完页才有），
  // 这时只显示"进行中"，不显示 0/0 这种会让人以为卡住的数字
  const jobIndicator = job ? (
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
        {jobLabel}{" "}
        {job.status === "running"
          ? job.total > 0
            ? `${job.processed}/${job.total}`
            : "进行中"
          : job.status === "done"
          ? "已完成"
          : "已终止"}
      </Tag>
    </Popover>
  ) : null;

  // 一个同步操作都没授权（比如需求方）：不展示操作入口，但仍要能看到正在跑的任务
  if (granted.length === 0) return jobIndicator ? <Space size={8}>{jobIndicator}</Space> : null;

  return (
    <Space size={8}>
      <Dropdown menu={{ items, onClick: onMenuClick }} trigger={["click"]}>
        <Button icon={<CloudSyncOutlined />} loading={busy || singleSyncing || loginStarting}>
          更新工单 <DownOutlined />
        </Button>
      </Dropdown>
      {jobIndicator}

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
        {pendingTapdCode && (
          <p style={{ color: "#d4380d" }}>
            检测到 TAPD 尚未登录，需要先完成扫码登录；登录成功后会自动开始
            {pendingTapdCode.code ? `获取工单 ${pendingTapdCode.code} 的TAPD信息` : "按当前筛选获取TAPD信息"}。
          </p>
        )}
        <p>已弹出一个浏览器窗口并停在 TAPD 首页，请在那个窗口里完成登录（可能需要先点"登录"按钮才会出现二维码，再用手机扫码）。</p>
        <p>登录成功、能看到 TAPD 工作台后，回到这里点击下方按钮保存登录态；之后的同步会直接复用，不需要再扫码。</p>
        <p style={{ color: "#8c8c8c", fontSize: 12, marginBottom: 0 }}>
          注意：浏览器窗口是在运行后端服务的那台机器上弹出的。超过15分钟未确认会自动关闭，需要重新发起。
        </p>
      </Modal>
    </Space>
  );
}
