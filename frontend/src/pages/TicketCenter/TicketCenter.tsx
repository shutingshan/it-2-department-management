import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Dropdown, Input, Pagination, Popconfirm, Popover, Select, Space, Table, Tag, Typography, message } from "antd";
import { CopyOutlined, DeleteOutlined, ExportOutlined } from "@ant-design/icons";
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
import { useViewTargetStore } from "../../store/viewTarget";
import { useTickets } from "./useTickets";
import type { TicketFilters } from "./useTickets";
import FilterBar from "./FilterBar";
import DetailModal from "./DetailModal";
import StatCards from "./StatCards";
import SubTicketsModal from "./SubTicketsModal";
import DraggableHeaderCell from "./DraggableHeaderCell";
import { copyText } from "../../utils/clipboard";
import "./TicketCenter.css";

const FIXED_LEFT_KEYS = ["code", "tapdUrl", "owningApp", "requester", "title"];
const DEFAULT_MIDDLE_ORDER = [
  "content",
  "category",
  "requesterDept",
  "watcher",
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
const WIDTH_STORAGE_KEY = "tc-column-widths";

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

// 用户手动拖拽调整过的列宽，按列 key 存；没调整过的列不在这里，用 columnDefs 里的默认宽度
function loadColumnWidths(): Record<string, number> {
  try {
    const saved = JSON.parse(localStorage.getItem(WIDTH_STORAGE_KEY) ?? "null");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) return saved;
  } catch {
    // 忽略损坏的本地存储数据
  }
  return {};
}

// 紧急是文本字段（可填"紧急"/"急"等），不是开关
function InlineUrgentInput({ ticket, onSaved }: { ticket: Ticket; onSaved: () => void }) {
  const { user } = useAuthStore();
  const [value, setValue] = useState(ticket.urgent);
  const [saving, setSaving] = useState(false);

  useEffect(() => setValue(ticket.urgent), [ticket.urgent]);

  async function commit() {
    if (!user || value === ticket.urgent) return;
    setSaving(true);
    try {
      await api.patch(`/tickets/${ticket.id}`, {
        fields: { urgent: value },
        actor: user.name,
        actorRole: user.role,
      });
      onSaved();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "紧急字段保存失败");
      setValue(ticket.urgent);
    } finally {
      setSaving(false);
    }
  }

  // IT 受理人仅能编辑本人负责的工单；需求方可见的工单本身已限定为本人相关，管理员不受限
  const canEdit = !(user?.role === "it_handler" && ticket.itHandler !== user.name);

  return (
    <Input
      size="small"
      value={value}
      disabled={saving || !canEdit}
      placeholder="填写紧急"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onPressEnter={(e) => (e.target as HTMLInputElement).blur()}
    />
  );
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

  const canEdit = !(user?.role === "it_handler" && ticket.itHandler !== user.name);

  return (
    <Input
      size="small"
      value={value}
      disabled={saving || !canEdit}
      placeholder="填写备注"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onPressEnter={(e) => (e.target as HTMLInputElement).blur()}
    />
  );
}

// 月度计划：仅管理员可在列表里直接维护，用于 TAPD 上还没填时先手工补上。
// 注意它仍归 TAPD 管——下一次「获取TAPD信息」会按 TAPD 的值直接覆盖，
// TAPD 上是空的就会被清空，这里的手工值不做保护，是有意为之
function InlineMonthlyPlanInput({
  ticket,
  options,
  onSaved,
}: {
  ticket: Ticket;
  options: string[];
  onSaved: () => void;
}) {
  const { user } = useAuthStore();
  const [value, setValue] = useState<string[]>(ticket.monthlyPlan);
  const [saving, setSaving] = useState(false);

  useEffect(() => setValue(ticket.monthlyPlan), [ticket.monthlyPlan]);

  if (user?.role !== "admin") {
    return <>{ticket.monthlyPlan.join("、") || "-"}</>;
  }

  async function commit(next: string[]) {
    if (!user) return;
    const cleaned = Array.from(new Set(next.map((v) => v.trim()).filter(Boolean)));
    if (cleaned.join("、") === ticket.monthlyPlan.join("、")) return;
    setSaving(true);
    try {
      await api.patch(`/tickets/${ticket.id}`, {
        fields: { monthlyPlan: cleaned },
        actor: user.name,
        actorRole: user.role,
      });
      onSaved();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "月度计划保存失败");
      setValue(ticket.monthlyPlan);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Select
      size="small"
      mode="tags"
      style={{ width: "100%" }}
      placeholder="填写月度计划"
      disabled={saving}
      value={value}
      options={options.map((v) => ({ value: v, label: v }))}
      onChange={setValue}
      onBlur={() => commit(value)}
      maxTagCount={1}
      tokenSeparators={["、", ",", "，"]}
    />
  );
}

// 标题/内容这类长文本列：单元格本身省略号截断，点击后在下方弹出完整内容，而不是靠悬停
function ExpandableCell({ text }: { text: string }) {
  return (
    <Popover
      trigger="click"
      placement="bottomLeft"
      content={<div className="tc-expandable-popover-content">{text || "-"}</div>}
    >
      <span className="tc-expandable-cell">{text}</span>
    </Popover>
  );
}

// 点击TAPD列地址：只跳转到TAPD需求详情页，不再触发同步（同步统一走"获取TAPD信息"按钮）
function TapdLinkCell({ ticket }: { ticket: Ticket }) {
  if (!ticket.tapdUrl) {
    return <Typography.Text type="secondary">-</Typography.Text>;
  }

  return (
    <a href={ticket.tapdUrl} target="_blank" rel="noreferrer">
      查看
    </a>
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
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(loadColumnWidths);
  // 手动删除：勾选的工单 id，以及删除请求进行中的标记
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  // 正在导出的菜单项 key，用于给「导出」按钮加 loading，避免大数据量时以为没点上而重复点
  const [exporting, setExporting] = useState<string | null>(null);

  // 表格高度不能写死：统计卡片、筛选栏（选中条件多时会换行）的高度都是变的。
  // 这里实测表格容器剩余的可用高度，减掉表头后作为表体的滚动高度，
  // 保证表格始终撑满一屏、且只在表格内部滚动，页面本身不出现滚动条
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const [tableScrollY, setTableScrollY] = useState(360);
  useEffect(() => {
    const el = tableWrapRef.current;
    if (!el) return;
    const update = () => {
      const headerHeight =
        el.querySelector<HTMLElement>(".ant-table-thead")?.getBoundingClientRect().height ?? 39;
      setTableScrollY(Math.max(160, Math.round(el.clientHeight - headerHeight)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(columnOrder));
  }, [columnOrder]);

  useEffect(() => {
    localStorage.setItem(WIDTH_STORAGE_KEY, JSON.stringify(columnWidths));
  }, [columnWidths]);

  function handleColumnResize(key: string, width: number) {
    setColumnWidths((w) => ({ ...w, [key]: width }));
  }

  // 支持从头部"我负责的工单"等入口重复导航到 /tickets 时，也能重新应用筛选条件
  useEffect(() => {
    if (location.state) {
      setFilters((f) => ({ ...f, ...(location.state as TicketFilters) }));
      setPage(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  // 头部"切换人员"选中的人（可多选）直接作用到列表：按 IT 受理人筛选，空则不限人员
  const { targets } = useViewTargetStore();
  useEffect(() => {
    setFilters((f) => ({ ...f, itHandler: targets.length ? targets : undefined }));
    setPage(1);
  }, [targets]);

  const { setFilters: publishFilters } = useFilteredTicketsStore();
  useEffect(() => {
    publishFilters(filters);
  }, [filters, publishFilters]);

  // 工单同步时间：记录上一次"更新工单"逻辑处理完成的时间
  useEffect(() => {
    api.get("/sync/status").then((res) => setLastUpdateTime(res.data.lastUpdateTime));
  }, [refreshTick]);

  const { data, total, facets, loading, reload } = useTickets(filters, page, pageSize, refreshTick);
  const { user } = useAuthStore();

  function openDetail(id: string) {
    setActiveTicketId(id);
    setDetailOpen(true);
  }

  // 手动删除工单：勾选后删除，仅管理员可见可用。删除是不可逆的，
  // 后端会在删之前把整份数据备份一次，误删可以整体回滚
  async function handleBulkDelete() {
    if (!user || selectedRowKeys.length === 0) return;
    setDeleting(true);
    try {
      const res = await api.post("/tickets/bulk-delete", {
        ids: selectedRowKeys,
        actor: user.name,
        actorRole: user.role,
      });
      message.success(
        `已删除 ${res.data.deletedCount} 条工单` +
          (res.data.backupFile ? `，删除前已备份到 backend/data/${res.data.backupFile}` : ""),
        8
      );
      setSelectedRowKeys([]);
      reload();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "删除工单失败");
    } finally {
      setDeleting(false);
    }
  }

  // all=按当前筛选全量导出（单个 xlsx）；selected=只导勾选的（单个 xlsx）；
  // requester/itHandler=按人分组导出，每人一个文件打成 zip
  async function handleExport(key: "all" | "selected" | "requester" | "itHandler") {
    if (key === "selected" && selectedRowKeys.length === 0) {
      message.warning("请先在列表中勾选要导出的工单");
      return;
    }
    const body: Record<string, unknown> = { ...filters, actor: user?.name, actorRole: user?.role };
    if (key === "all" || key === "selected") body.scope = key;
    else body.groupBy = key;
    if (key === "selected") body.ids = selectedRowKeys;

    setExporting(key);
    try {
      const res = await api.post("/export", body, { responseType: "blob" });
      // 文件名由后端给出（含条数与时间戳），拿不到再退回一个默认名
      const disposition = res.headers["content-disposition"] as string | undefined;
      const matched = disposition?.match(/filename="?([^";]+)"?/);
      const isZip = key === "requester" || key === "itHandler";
      const fallback = `IT二部工单数据.${isZip ? "zip" : "xlsx"}`;
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = matched ? decodeURIComponent(matched[1]) : fallback;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      // responseType 是 blob，报错信息也是 blob，要读出来才拿得到后端的提示文案
      let msg = "导出失败";
      try {
        const text = await (e?.response?.data as Blob)?.text?.();
        msg = text ? JSON.parse(text).message ?? msg : msg;
      } catch {
        // 解析不出来就用兜底文案
      }
      message.error(msg);
    } finally {
      setExporting(null);
    }
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
              onClick={async () => {
                const ok = await copyText(code);
                if (ok) message.success(`已复制编号 ${code}`);
                else message.error("复制失败，请手动选中编号复制");
              }}
            />
          </Space>
        ),
      },
      tapdUrl: {
        title: "TAPD",
        dataIndex: "tapdUrl",
        width: 90,
        render: (_: string | null, r: Ticket) => <TapdLinkCell ticket={r} />,
      },
      owningApp: { title: "归属应用", dataIndex: "owningApp", width: 110, ellipsis: true },
      requester: { title: "发起人", dataIndex: "requester", width: 90 },
      title: {
        title: "标题",
        dataIndex: "title",
        width: 220,
        ellipsis: { showTitle: false },
        render: (title: string) => <ExpandableCell text={title} />,
      },
      content: {
        title: "内容",
        dataIndex: "content",
        width: 260,
        ellipsis: { showTitle: false },
        render: (content: string) => <ExpandableCell text={content} />,
      },
      category: { title: "分类", dataIndex: "category", width: 90 },
      requesterDept: { title: "发起部门", dataIndex: "requesterDept", width: 110, ellipsis: true },
      watcher: {
        title: "关注人",
        dataIndex: "watcher",
        width: 130,
        ellipsis: true,
        render: (v: string[]) => v.join("、") || "-",
      },
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
        render: (_: string, r: Ticket) => <InlineUrgentInput ticket={r} onSaved={reload} />,
      },
      priority: { title: "优先级", dataIndex: "priority", width: 80, render: (v: string | null) => v ?? "-" },
      monthlyPlan: {
        title: "月度计划",
        dataIndex: "monthlyPlan",
        width: 160,
        // 下拉候选取自当前列表已有的月度计划值（facets 由后端按当前筛选范围算出），
        // 同时是 tags 模式，列表里还没出现过的新值也能直接输入
        render: (_: string[], r: Ticket) => (
          <InlineMonthlyPlanInput ticket={r} options={facets.monthlyPlans} onSaved={reload} />
        ),
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
    [reload, facets.monthlyPlans]
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
  ].map((col: any) => {
    const width = columnWidths[col.key] ?? col.width;
    return {
      ...col,
      width,
      onHeaderCell: (column: any) => ({
        // 列顺序拖拽仅对中间可调序的列开放，固定列/操作列不可拖拽排序；
        // 列宽拖拽则所有列都开放，两者是独立的两回事
        columnKey: FIXED_LEFT_KEYS.includes(column.key) || column.key === "actions" ? undefined : column.key,
        resizeKey: column.key,
        width,
        onResize: handleColumnResize,
      }),
    };
  }) as ColumnsType<Ticket>;

  // 横向滚动总宽度按当前各列实际宽度算，而不是写死一个数——不然列宽调整后横向滚动范围会跟视觉不一致
  const scrollX = columns.reduce((sum, col: any) => sum + (typeof col.width === "number" ? col.width : 100), 0);

  return (
    <div className="ticket-center-page">
      <StatCards
        activeCardKey={filters.cardKey}
        refreshKey={refreshTick}
        itHandlers={targets}
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
          <Space size={8}>
            <Dropdown
              menu={{
                items: [
                  { key: "all", label: "全量导出（按当前筛选）" },
                  {
                    key: "selected",
                    label: `导出所选数据${selectedRowKeys.length ? `（${selectedRowKeys.length}）` : ""}`,
                    disabled: selectedRowKeys.length === 0,
                  },
                  { type: "divider" },
                  { key: "requester", label: "按发起人导出" },
                  { key: "itHandler", label: "按IT受理人导出" },
                ],
                onClick: ({ key }) => handleExport(key as "all" | "selected" | "requester" | "itHandler"),
              }}
              trigger={["click"]}
            >
              <Button size="small" icon={<ExportOutlined />} loading={!!exporting}>
                导出
              </Button>
            </Dropdown>
            {user?.role === "admin" && selectedRowKeys.length > 0 && (
              <Popconfirm
                title={`确认删除选中的 ${selectedRowKeys.length} 条工单？`}
                description="删除不可撤销，删除前会自动备份整份数据以便回滚"
                okText="确认删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onConfirm={handleBulkDelete}
              >
                <Button size="small" danger icon={<DeleteOutlined />} loading={deleting}>
                  删除选中 {selectedRowKeys.length}
                </Button>
              </Popconfirm>
            )}
          </Space>
        }
        rightExtra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            工单同步时间：{lastUpdateTime || "-"}
          </Typography.Text>
        }
      />

      <div className="tc-table-card">
        <div className="tc-table-scroll" ref={tableWrapRef}>
          <DndContext sensors={sensors} modifiers={[restrictToHorizontalAxis]} onDragEnd={handleDragEnd}>
            <SortableContext items={columnOrder} strategy={horizontalListSortingStrategy}>
            <Table
              rowKey="id"
              size="small"
              loading={loading}
              dataSource={data}
              columns={columns}
              pagination={false}
              // 勾选用于「导出所选数据」（所有角色可用）与「删除选中」（仅管理员，
              // 删除按钮本身另有角色判断，这里不再限制勾选框的显示）
              rowSelection={{
                fixed: true,
                selectedRowKeys,
                onChange: (keys) => setSelectedRowKeys(keys as string[]),
              }}
              sticky
              scroll={{ x: scrollX, y: tableScrollY }}
              rowClassName={(r) => (r.urgent.trim() ? "row-urgent" : "")}
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
        </div>
        <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-end" }}>
          <Pagination
            size="small"
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
