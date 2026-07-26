import { useEffect, useMemo, useState } from "react";
import { Button, Input, Pagination, Space, Switch, Table, Tag, Tooltip, Typography, message } from "antd";
import { CopyOutlined, ExportOutlined } from "@ant-design/icons";
import type { ColumnsType, ColumnType } from "antd/es/table";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { arrayMove, horizontalListSortingStrategy, SortableContext } from "@dnd-kit/sortable";
import { useLocation, useOutletContext } from "react-router-dom";
import { api } from "../../api/client";
import { formatIterations, hoursDeviation, STAGE_COLORS } from "../../api/types";
import type { Ticket } from "../../api/types";
import { useAuthStore } from "../../store/auth";
import { useFilteredTicketsStore } from "../../store/filteredTickets";
import { useTickets } from "./useTickets";
import type { TicketFilters } from "./useTickets";
import FilterBar from "./FilterBar";
import DetailModal from "./DetailModal";
import StatCards from "./StatCards";
import SubTicketsModal from "./SubTicketsModal";
import DraggableHeaderCell from "./DraggableHeaderCell";
import "./TicketCenter.css";

const FIXED_LEFT_KEYS = ["code", "tapdUrl", "owningApp", "requester", "title"];
const DEFAULT_MIDDLE_ORDER = [
  "content",
  "category",
  "module",
  "requesterDept",
  "currentHandler",
  "itHandler",
  "developer",
  "stage",
  "status",
  "devStatus",
  "urgent",
  "priority",
  "monthlyPlan",
  "iterations",
  "expectedTriageTime",
  "actualTriageTime",
  "expectedCompleteTime",
  "actualCompleteTime",
  "estimatedHours",
  "actualHours",
  "hoursDeviation",
  "remark",
  "submittedAt",
];

const ORDER_STORAGE_KEY = "tc-column-order";

function loadColumnOrder(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(ORDER_STORAGE_KEY) ?? "null");
    if (
      Array.isArray(saved) &&
      saved.length === DEFAULT_MIDDLE_ORDER.length &&
      DEFAULT_MIDDLE_ORDER.every((k) => saved.includes(k))
    ) {
      return saved;
    }
  } catch {
    // 忽略损坏的本地存储数据
  }
  return DEFAULT_MIDDLE_ORDER;
}

function InlineUrgentSwitch({ ticket, onSaved }: { ticket: Ticket; onSaved: () => void }) {
  const { user } = useAuthStore();
  const [loading, setLoading] = useState(false);

  async function toggle(checked: boolean) {
    if (!user) return;
    setLoading(true);
    try {
      await api.patch(`/tickets/${ticket.id}`, {
        fields: { urgent: checked },
        actor: user.name,
        actorRole: user.role,
      });
      onSaved();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "紧急字段保存失败");
    } finally {
      setLoading(false);
    }
  }

  return <Switch size="small" checked={ticket.urgent} loading={loading} onChange={toggle} />;
}

function InlineRemarkInput({ ticket, onSaved }: { ticket: Ticket; onSaved: () => void }) {
  const { user } = useAuthStore();
  const [value, setValue] = useState(ticket.remark);
  const [saving, setSaving] = useState(false);

  useEffect(() => setValue(ticket.remark), [ticket.remark]);

  async function commit() {
    if (!user || value === ticket.remark) return;
    setSaving(true);
    try {
      await api.patch(`/tickets/${ticket.id}`, {
        fields: { remark: value },
        actor: user.name,
        actorRole: user.role,
      });
      onSaved();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "备注保存失败");
      setValue(ticket.remark);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Input
      size="small"
      value={value}
      disabled={saving}
      placeholder="填写备注"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onPressEnter={(e) => (e.target as HTMLInputElement).blur()}
    />
  );
}

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
  const [subTicketsFor, setSubTicketsFor] = useState<Ticket | null>(null);
  const [lastUpdateTime, setLastUpdateTime] = useState("");
  const [columnOrder, setColumnOrder] = useState<string[]>(loadColumnOrder);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(columnOrder));
  }, [columnOrder]);

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

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setColumnOrder((prev) => {
        const oldIndex = prev.indexOf(String(active.id));
        const newIndex = prev.indexOf(String(over.id));
        return arrayMove(prev, oldIndex, newIndex);
      });
    }
  }

  const columnDefs: Record<string, ColumnType<Ticket>> = useMemo(
    () => ({
      code: {
        title: "编号",
        dataIndex: "code",
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
      tapdUrl: {
        title: "TAPD",
        dataIndex: "tapdUrl",
        width: 90,
        render: (url: string | null) =>
          url ? (
            <a href={url} target="_blank" rel="noreferrer">
              查看
            </a>
          ) : (
            <Typography.Text type="secondary">-</Typography.Text>
          ),
      },
      owningApp: { title: "归属应用", dataIndex: "owningApp", width: 110, ellipsis: true },
      requester: { title: "发起人", dataIndex: "requester", width: 90 },
      title: {
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
      content: {
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
      category: { title: "分类", dataIndex: "category", width: 90 },
      module: { title: "模块", dataIndex: "module", width: 100, ellipsis: true },
      requesterDept: { title: "发起部门", dataIndex: "requesterDept", width: 110, ellipsis: true },
      currentHandler: { title: "当前处理人", dataIndex: "currentHandler", width: 140, ellipsis: true },
      itHandler: { title: "IT受理人", dataIndex: "itHandler", width: 90 },
      developer: {
        title: "开发人员",
        dataIndex: "developer",
        width: 130,
        ellipsis: true,
        render: (d: string[]) => d.join("、") || "-",
      },
      stage: {
        title: "工单阶段",
        dataIndex: "stage",
        width: 100,
        render: (stage: Ticket["stage"]) => <Tag color={STAGE_COLORS[stage]}>{stage}</Tag>,
      },
      status: { title: "状态", dataIndex: "status", width: 90 },
      devStatus: {
        title: "TAPD状态",
        dataIndex: "devStatus",
        width: 100,
        render: (v: string | null) => v ?? "-",
      },
      urgent: {
        title: "紧急",
        dataIndex: "urgent",
        width: 70,
        render: (_: boolean, r: Ticket) => <InlineUrgentSwitch ticket={r} onSaved={reload} />,
      },
      priority: { title: "优先级", dataIndex: "priority", width: 80, render: (v: string | null) => v ?? "-" },
      monthlyPlan: {
        title: "月度计划",
        dataIndex: "monthlyPlan",
        width: 120,
        ellipsis: true,
        render: (v: string[]) => v.join("、") || "-",
      },
      iterations: {
        title: "迭代",
        dataIndex: "iterations",
        width: 110,
        ellipsis: true,
        render: (v: Ticket["iterations"]) => formatIterations(v),
      },
      expectedTriageTime: { title: "预计梳理完成时间", dataIndex: "expectedTriageTime", width: 120, render: (v: string | null) => v ?? "-" },
      actualTriageTime: { title: "实际梳理完成时间", dataIndex: "actualTriageTime", width: 120, render: (v: string | null) => v ?? "-" },
      expectedCompleteTime: { title: "预计完成时间", dataIndex: "expectedCompleteTime", width: 110 },
      actualCompleteTime: { title: "实际完成时间", dataIndex: "actualCompleteTime", width: 110 },
      estimatedHours: { title: "预估工时", dataIndex: "estimatedHours", width: 90 },
      actualHours: { title: "完成工时", dataIndex: "actualHours", width: 90 },
      hoursDeviation: {
        title: "工时偏差",
        width: 90,
        render: (_, r) => {
          const d = hoursDeviation(r);
          const cls = d >= 5 ? "dev-red" : d > 0 ? "dev-yellow" : "";
          return <span className={cls}>{d}</span>;
        },
      },
      remark: {
        title: "备注",
        dataIndex: "remark",
        width: 160,
        render: (_: string, r: Ticket) => <InlineRemarkInput ticket={r} onSaved={reload} />,
      },
      submittedAt: { title: "提交时间", dataIndex: "submittedAt", width: 140 },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reload]
  );

  const columns: ColumnsType<Ticket> = [
    ...FIXED_LEFT_KEYS.map((key) => ({ ...columnDefs[key], key, fixed: "left" as const })),
    ...columnOrder.map((key) => ({ ...columnDefs[key], key })),
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      width: 110,
      render: (_: unknown, r: Ticket) => (
        <Space size={4}>
          <a onClick={() => openDetail(r.id)}>详情</a>
          <a
            onClick={() => r.subTickets.length > 0 && setSubTicketsFor(r)}
            aria-disabled={r.subTickets.length === 0}
            style={r.subTickets.length === 0 ? { color: "#d9d9d9", cursor: "not-allowed" } : undefined}
          >
            子需求
          </a>
        </Space>
      ),
    },
  ].map((col: any) => ({
    ...col,
    onHeaderCell: (column: any) => ({
      columnKey: FIXED_LEFT_KEYS.includes(column.key) || column.key === "actions" ? undefined : column.key,
    }),
  })) as ColumnsType<Ticket>;

  return (
    <div className="ticket-center-page">
      <StatCards
        activeCardKey={filters.cardKey}
        refreshKey={refreshTick}
        onSelect={(cardKey) => {
          setFilters({ sortField: "submittedAt", sortOrder: "desc", cardKey });
          setPage(1);
        }}
      />

      <FilterBar
        filters={filters}
        onChange={setFilters}
        facets={facets}
        extra={
          <Button icon={<ExportOutlined />} onClick={handleExport}>
            导出
          </Button>
        }
        rightExtra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            工单同步时间：{lastUpdateTime || "-"}
          </Typography.Text>
        }
      />

      <div className="tc-table-card">
        <DndContext sensors={sensors} modifiers={[restrictToHorizontalAxis]} onDragEnd={handleDragEnd}>
          <SortableContext items={columnOrder} strategy={horizontalListSortingStrategy}>
            <Table
              rowKey="id"
              size="small"
              loading={loading}
              dataSource={data}
              columns={columns}
              pagination={false}
              sticky
              scroll={{ x: 2600, y: "calc(100vh - 420px)" }}
              components={{ header: { cell: DraggableHeaderCell } }}
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
          </SortableContext>
        </DndContext>
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

      <DetailModal
        ticketId={activeTicketId}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        onSaved={reload}
      />

      <SubTicketsModal
        open={!!subTicketsFor}
        onClose={() => setSubTicketsFor(null)}
        ticketCode={subTicketsFor?.code ?? ""}
        subTickets={subTicketsFor?.subTickets ?? []}
      />
    </div>
  );
}
