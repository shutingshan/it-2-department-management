import { useEffect, useState } from "react";
import { Button, Pagination, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import { CopyOutlined, ExportOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { useLocation, useOutletContext } from "react-router-dom";
import { api } from "../../api/client";
import { hoursDeviation, STAGE_COLORS } from "../../api/types";
import type { Ticket } from "../../api/types";
import { useFilteredTicketsStore } from "../../store/filteredTickets";
import { useTickets } from "./useTickets";
import type { TicketFilters } from "./useTickets";
import FilterBar from "./FilterBar";
import DetailDrawer from "./DetailDrawer";
import StatCards from "./StatCards";
import "./TicketCenter.css";

export default function TicketCenter() {
  const { refreshTick } = useOutletContext<{ refreshTick: number }>();
  const location = useLocation();
  const [filters, setFilters] = useState<TicketFilters>(() => {
    const stateFilters = location.state as TicketFilters | undefined;
    // 任何角色进入工单中心，若不是带着具体筛选条件跳转过来的，默认按"未完成未关闭"卡片筛选
    return {
      sortField: "submittedAt",
      sortOrder: "desc",
      ...(stateFilters ?? { cardKey: "not-done" }),
    };
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [lastUpdateTime, setLastUpdateTime] = useState("");

  // 支持从头部"我负责的工单"等入口重复导航到 /tickets 时，也能重新应用筛选条件
  useEffect(() => {
    if (location.state) {
      setFilters((f) => ({ ...f, ...(location.state as TicketFilters) }));
      setPage(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  const { setFilters: publishFilters } = useFilteredTicketsStore();
  useEffect(() => {
    publishFilters(filters);
  }, [filters, publishFilters]);

  // 工单同步时间：记录上一次"更新工单"逻辑处理完成的时间
  useEffect(() => {
    api.get("/sync/status").then((res) => setLastUpdateTime(res.data.lastUpdateTime));
  }, [refreshTick]);

  const { data, total, facets, loading, reload } = useTickets(filters, page, pageSize, refreshTick);

  function openDetail(id: string) {
    setActiveTicketId(id);
    setDetailOpen(true);
  }

  async function handleExport() {
    const res = await api.post("/export", filters, { responseType: "blob" });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = "IT二部工单数据.zip";
    a.click();
    URL.revokeObjectURL(url);
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
    { title: "优先级", dataIndex: "priority", width: 80, render: (v: string | null) => v ?? "-" },
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
      width: 70,
      render: (_, r) => <a onClick={() => openDetail(r.id)}>详情</a>,
    },
  ];

  return (
    <div className="ticket-center-page">
      <div className="tc-toolbar">
        <Space>
          <Button icon={<ExportOutlined />} onClick={handleExport}>
            导出
          </Button>
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          工单同步时间：{lastUpdateTime || "-"}
        </Typography.Text>
      </div>

      <StatCards
        activeCardKey={filters.cardKey}
        refreshKey={refreshTick}
        onSelect={(cardKey) => {
          setFilters({ sortField: "submittedAt", sortOrder: "desc", cardKey });
          setPage(1);
        }}
      />

      <FilterBar filters={filters} onChange={setFilters} facets={facets} />

      <div className="tc-table-card">
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={data}
          columns={columns}
          pagination={false}
          scroll={{ x: 2400, y: "calc(100vh - 420px)" }}
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
      </div>

      <DetailDrawer
        ticketId={activeTicketId}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        onSaved={reload}
      />
    </div>
  );
}
