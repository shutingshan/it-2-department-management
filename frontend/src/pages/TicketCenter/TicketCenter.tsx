import { useMemo, useState } from "react";
import {
  Button,
  Modal,
  Pagination,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import {
  AppstoreOutlined,
  CopyOutlined,
  DownloadOutlined,
  ExportOutlined,
  ReloadOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { useLocation, useOutletContext } from "react-router-dom";
import { api } from "../../api/client";
import { hoursDeviation, STAGE_COLORS } from "../../api/types";
import type { Ticket } from "../../api/types";
import { useAuthStore } from "../../store/auth";
import { useTickets } from "./useTickets";
import type { TicketFilters } from "./useTickets";
import FilterBar from "./FilterBar";
import DetailDrawer from "./DetailDrawer";
import KanbanView from "./KanbanView";
import "./TicketCenter.css";

export default function TicketCenter() {
  const { user } = useAuthStore();
  const { refreshTick } = useOutletContext<{ refreshTick: number }>();
  const location = useLocation();
  const [filters, setFilters] = useState<TicketFilters>({
    sortField: "submittedAt",
    sortOrder: "desc",
    ...((location.state as TicketFilters | undefined) ?? {}),
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [view, setView] = useState<"list" | "kanban">("list");
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [batchTransferOpen, setBatchTransferOpen] = useState(false);
  const [localRefresh, setLocalRefresh] = useState(0);

  const { data, total, facets, loading, reload } = useTickets(
    filters,
    page,
    pageSize,
    refreshTick + localRefresh
  );

  const lastTicket = useMemo(
    () => data.find((t) => t.id === activeTicketId) ?? null,
    [data, activeTicketId]
  );

  function openDetail(id: string) {
    setActiveTicketId(id);
    setDetailOpen(true);
  }

  async function handleClaim(t: Ticket) {
    if (!user) return;
    await api.post(`/tickets/${t.id}/claim`, { actor: user.name });
    message.success(`已接单：${t.code}`);
    reload();
  }

  async function handleExport(groupBy?: "requester" | "itHandler") {
    const res = await api.post("/export", { ...filters, groupBy }, { responseType: "blob" });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = "工单导出.zip";
    a.click();
    URL.revokeObjectURL(url);
    setExportOpen(false);
  }

  const columns: ColumnsType<Ticket> = [
    {
      title: "编号",
      dataIndex: "code",
      fixed: "left",
      width: 150,
      render: (code: string, r) => (
        <Space size={4}>
          <a onClick={() => openDetail(r.id)}>{code}</a>
          <CopyOutlined
            style={{ color: "#8c8c8c", cursor: "pointer" }}
            onClick={() => {
              navigator.clipboard.writeText(code);
              message.success("已复制编号");
            }}
          />
        </Space>
      ),
    },
    { title: "分类", dataIndex: "category", width: 90 },
    { title: "归属应用", dataIndex: "owningApp", width: 110 },
    { title: "模块", dataIndex: "module", width: 100, ellipsis: true },
    {
      title: "标题",
      dataIndex: "title",
      width: 220,
      ellipsis: { showTitle: false },
      render: (title: string) => (
        <Tooltip title={title}>
          <span>{title}</span>
        </Tooltip>
      ),
    },
    {
      title: "内容",
      dataIndex: "content",
      width: 260,
      ellipsis: { showTitle: false },
      render: (content: string) => (
        <Tooltip title={content}>
          <span>{content}</span>
        </Tooltip>
      ),
    },
    {
      title: "TAPD地址",
      dataIndex: "tapdUrl",
      width: 100,
      render: (url: string | null) =>
        url ? (
          <a href={url} target="_blank" rel="noreferrer">
            查看
          </a>
        ) : (
          <Typography.Text type="secondary">-</Typography.Text>
        ),
    },
    { title: "发起人", dataIndex: "requester", width: 90 },
    { title: "发起部门", dataIndex: "requesterDept", width: 110, ellipsis: true },
    { title: "当前处理人", dataIndex: "currentHandler", width: 140, ellipsis: true },
    { title: "IT受理人", dataIndex: "itHandler", width: 90 },
    {
      title: "开发人员",
      dataIndex: "developer",
      width: 130,
      ellipsis: true,
      render: (d: string[]) => d.join("、") || "-",
    },
    {
      title: "工单阶段",
      dataIndex: "stage",
      width: 100,
      render: (stage: Ticket["stage"]) => <Tag color={STAGE_COLORS[stage]}>{stage}</Tag>,
    },
    { title: "状态", dataIndex: "status", width: 90 },
    {
      title: "紧急",
      dataIndex: "urgent",
      width: 70,
      render: (v: boolean) => (v ? <Tag color="red">是</Tag> : "否"),
    },
    {
      title: "月度计划",
      dataIndex: "monthlyPlan",
      width: 120,
      ellipsis: true,
      render: (v: string[]) => v.join("、") || "-",
    },
    {
      title: "迭代",
      dataIndex: "iterations",
      width: 110,
      ellipsis: true,
      render: (v: Ticket["iterations"]) => v.map((i) => i.name).join("、") || "-",
    },
    { title: "预估工时", dataIndex: "estimatedHours", width: 90 },
    { title: "实际工时", dataIndex: "actualHours", width: 90 },
    {
      title: "工时偏差",
      width: 90,
      render: (_, r) => {
        const d = hoursDeviation(r);
        const cls = d >= 5 ? "dev-red" : d > 0 ? "dev-yellow" : "";
        return <span className={cls}>{d}</span>;
      },
    },
    { title: "预计完成时间", dataIndex: "expectedCompleteTime", width: 110 },
    { title: "实际完成时间", dataIndex: "actualCompleteTime", width: 110 },
    { title: "提交时间", dataIndex: "submittedAt", width: 140 },
    {
      title: "操作",
      fixed: "right",
      width: 130,
      render: (_, r) => (
        <Space size={4}>
          <a onClick={() => openDetail(r.id)}>详情</a>
          <a onClick={() => handleClaim(r)}>接单</a>
          <TransferAction ticket={r} handlers={facets.itHandlers} onDone={reload} />
        </Space>
      ),
    },
  ];

  return (
    <div className="ticket-center-page">
      <div className="tc-toolbar">
        <Space>
          <Button
            disabled={selectedKeys.length === 0}
            onClick={() => setBatchTransferOpen(true)}
          >
            批量转交（{selectedKeys.length}）
          </Button>
          <Button icon={<ExportOutlined />} onClick={() => setExportOpen(true)}>
            导出
          </Button>
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => setLocalRefresh((x) => x + 1)} />
          <Radio.Group value={view} onChange={(e) => setView(e.target.value)}>
            <Radio.Button value="list">
              <UnorderedListOutlined /> 列表
            </Radio.Button>
            <Radio.Button value="kanban">
              <AppstoreOutlined /> 看板
            </Radio.Button>
          </Radio.Group>
        </Space>
      </div>

      <FilterBar filters={filters} onChange={setFilters} facets={facets} />

      <div className="tc-table-card">
        {view === "list" ? (
          <>
            <Table
              rowKey="id"
              size="small"
              loading={loading}
              dataSource={data}
              columns={columns}
              pagination={false}
              scroll={{ x: 2400, y: "calc(100vh - 420px)" }}
              rowSelection={{
                selectedRowKeys: selectedKeys,
                onChange: setSelectedKeys,
              }}
              rowClassName={(r) => (r.urgent ? "row-urgent" : "")}
              onChange={(_, __, sorter: any) => {
                if (sorter?.field) {
                  setFilters((f) => ({
                    ...f,
                    sortField: sorter.field,
                    sortOrder: sorter.order === "ascend" ? "asc" : "desc",
                  }));
                }
              }}
            />
            <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
              <Pagination
                current={page}
                pageSize={pageSize}
                total={total}
                showSizeChanger
                showTotal={(t) => `共 ${t} 条`}
                onChange={(p, ps) => {
                  setPage(p);
                  setPageSize(ps);
                }}
              />
            </div>
          </>
        ) : (
          <KanbanView tickets={data} onOpen={openDetail} />
        )}
      </div>

      <div className="floating-actions">
        <Tooltip title="打开详情" placement="left">
          <Button
            type="primary"
            shape="circle"
            disabled={!activeTicketId}
            onClick={() => activeTicketId && setDetailOpen(true)}
          >
            详
          </Button>
        </Tooltip>
        <Tooltip title={lastTicket && lastTicket.subTickets.length > 0 ? "查看子需求" : "无子需求"} placement="left">
          <Button
            shape="circle"
            disabled={!lastTicket || lastTicket.subTickets.length === 0}
            onClick={() => activeTicketId && setDetailOpen(true)}
          >
            子
          </Button>
        </Tooltip>
      </div>

      <DetailDrawer
        ticketId={activeTicketId}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        onSaved={reload}
      />

      <Modal
        title="导出工单"
        open={exportOpen}
        onCancel={() => setExportOpen(false)}
        footer={null}
      >
        <p>导出将按当前列表筛选条件生成 Excel（真实 xlsx），多文件将自动打包为压缩包。</p>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Button block icon={<DownloadOutlined />} onClick={() => handleExport()}>
            按当前筛选导出（单文件）
          </Button>
          <Button block icon={<DownloadOutlined />} onClick={() => handleExport("requester")}>
            按发起人导出（每人一个文件）
          </Button>
          <Button block icon={<DownloadOutlined />} onClick={() => handleExport("itHandler")}>
            按 IT 受理人导出（每人一个文件）
          </Button>
        </Space>
      </Modal>

      <BatchTransferModal
        open={batchTransferOpen}
        onClose={() => setBatchTransferOpen(false)}
        handlers={facets.itHandlers}
        onConfirm={async (target) => {
          if (!user) return;
          await Promise.all(
            selectedKeys.map((id) => api.post(`/tickets/${id}/transfer`, { actor: user.name, to: target }))
          );
          message.success(`已批量转交 ${selectedKeys.length} 条工单`);
          setSelectedKeys([]);
          setBatchTransferOpen(false);
          reload();
        }}
      />
    </div>
  );
}

function TransferAction({
  ticket,
  handlers,
  onDone,
}: {
  ticket: Ticket;
  handlers: string[];
  onDone: () => void;
}) {
  const { user } = useAuthStore();
  const [open, setOpen] = useState(false);
  return (
    <>
      <a onClick={() => setOpen(true)}>转交</a>
      <Modal
        title={`转交工单 ${ticket.code}`}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={async () => {
          setOpen(false);
        }}
        footer={null}
      >
        <Select
          style={{ width: "100%" }}
          placeholder="选择接收人"
          options={handlers.map((h) => ({ value: h, label: h }))}
          onChange={async (val) => {
            if (!user) return;
            await api.post(`/tickets/${ticket.id}/transfer`, { actor: user.name, to: val });
            message.success(`已转交给 ${val}`);
            setOpen(false);
            onDone();
          }}
        />
      </Modal>
    </>
  );
}

function BatchTransferModal({
  open,
  onClose,
  handlers,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  handlers: string[];
  onConfirm: (target: string) => void;
}) {
  const [target, setTarget] = useState<string>();
  return (
    <Modal title="批量转交" open={open} onCancel={onClose} onOk={() => target && onConfirm(target)}>
      <Select
        style={{ width: "100%" }}
        placeholder="选择接收人"
        options={handlers.map((h) => ({ value: h, label: h }))}
        value={target}
        onChange={setTarget}
      />
    </Modal>
  );
}
