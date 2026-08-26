import { useEffect, useState } from "react";
import {
  Button,
  Card,
  DatePicker,
  Dropdown,
  Input,
  InputNumber,
  Pagination,
  Popover,
  Select,
  Space,
  Table,
  message,
} from "antd";
import { CopyOutlined, ExportOutlined, SearchOutlined } from "@ant-design/icons";
import { copyText } from "../../utils/clipboard";
import type { ColumnsType, ColumnType } from "antd/es/table";
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { arrayMove, horizontalListSortingStrategy, SortableContext } from "@dnd-kit/sortable";
import DraggableHeaderCell from "../TicketCenter/DraggableHeaderCell";
import type { Ticket } from "../../api/types";
import { TICKET_STATUSES } from "../../api/types";
import { useOutletContext } from "react-router-dom";
import { api } from "../../api/client";
import { useAuthStore } from "../../store/auth";
import { useViewTargetStore } from "../../store/viewTarget";
import { EMPTY_TOKEN, useTickets } from "../TicketCenter/useTickets";
import type { TicketFilters } from "../TicketCenter/useTickets";
import dayjs from "dayjs";

const { RangePicker } = DatePicker;

const STATUS_OPTIONS = TICKET_STATUSES.map((v) => ({ value: v, label: v }));
const YES_NO_OPTIONS = [
  { value: "yes", label: "是" },
  { value: "no", label: "否" },
];
const COMPLETION_VALUES = ["未开始", "进行中", "已完成"] as const;
const COMPLETION_OPTIONS = COMPLETION_VALUES.map((v) => ({ value: v, label: v }));

// 筛选下拉比录入下拉多一个「未填写」，用于把还没维护的数据挑出来补齐
const YES_NO_FILTER_OPTIONS = [...YES_NO_OPTIONS, { value: EMPTY_TOKEN, label: "未填写" }];
const COMPLETION_FILTER_OPTIONS = [...COMPLETION_OPTIONS, { value: EMPTY_TOKEN, label: "未填写" }];

// 可拖拽调序的列（编号固定在最左，不在此列）。顺序记在 localStorage，刷新后保持
const DEFAULT_COLUMN_ORDER = [
  "owningApp",
  "requester",
  "itHandler",
  "status",
  "title",
  "content",
  "submittedAt",
  "hasTestCase",
  "testCaseSupplemented",
  "hasAutomatedTest",
  "automationPlanCompleteTime",
  "completionStatus",
  "spentHours",
  "remark",
];
const ORDER_STORAGE_KEY = "defect-column-order";

// 存下来的顺序必须跟当前列集合完全一致才复用——否则版本升级加了新列时，
// 老的本地顺序会让新列直接不显示
function loadColumnOrder(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(ORDER_STORAGE_KEY) ?? "null");
    if (
      Array.isArray(saved) &&
      saved.length === DEFAULT_COLUMN_ORDER.length &&
      DEFAULT_COLUMN_ORDER.every((k) => saved.includes(k))
    ) {
      return saved;
    }
  } catch {
    // 忽略损坏的本地存储数据
  }
  return DEFAULT_COLUMN_ORDER;
}

// 标题/内容较长，单元格省略号截断，点击后弹出完整内容
function ExpandableCell({ text }: { text: string }) {
  return (
    <Popover trigger="click" placement="bottomLeft" content={<div style={{ maxWidth: 420 }}>{text || "-"}</div>}>
      <span style={{ cursor: "pointer" }}>{text}</span>
    </Popover>
  );
}

// 缺陷跟进的编辑权限：能看到这条就能改。列表本身已按「受理人或发起人是本人」
// （管理员全部可见）收敛过，所以出现在列表里的行一律可编辑，后端同样按这个口径校验
function useCanEdit(_ticket: Ticket) {
  return true;
}

async function patchTicket(ticket: Ticket, field: string, value: unknown, actor: string, actorRole: string) {
  // view=defect 让后端走缺陷页那套编辑权限，而不是工单中心更严的那套
  await api.patch(`/tickets/${ticket.id}`, { fields: { [field]: value }, actor, actorRole, view: "defect" });
}

function InlineBooleanSelect({
  ticket,
  field,
  onSaved,
}: {
  ticket: Ticket;
  field: "hasTestCase" | "testCaseSupplemented" | "hasAutomatedTest";
  onSaved: () => void;
}) {
  const { user } = useAuthStore();
  const canEdit = useCanEdit(ticket);
  const [value, setValue] = useState(ticket[field]);
  const [saving, setSaving] = useState(false);

  useEffect(() => setValue(ticket[field]), [ticket, field]);

  async function commit(next: boolean | null) {
    if (!user || next === ticket[field]) return;
    setSaving(true);
    try {
      await patchTicket(ticket, field, next, user.name, user.role);
      onSaved();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "保存失败");
      setValue(ticket[field]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Select
      size="small"
      allowClear
      style={{ width: "100%" }}
      disabled={saving || !canEdit}
      placeholder="未填写"
      options={YES_NO_OPTIONS}
      value={value === null ? undefined : value ? "yes" : "no"}
      onChange={(v) => {
        const next = v === "yes" ? true : v === "no" ? false : null;
        setValue(next);
        commit(next);
      }}
      onClear={() => {
        setValue(null);
        commit(null);
      }}
    />
  );
}

function InlineDatePicker({ ticket, onSaved }: { ticket: Ticket; onSaved: () => void }) {
  const { user } = useAuthStore();
  const canEdit = useCanEdit(ticket);
  const [saving, setSaving] = useState(false);

  async function commit(next: string | null) {
    if (!user || next === ticket.automationPlanCompleteTime) return;
    setSaving(true);
    try {
      await patchTicket(ticket, "automationPlanCompleteTime", next, user.name, user.role);
      onSaved();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <DatePicker
      size="small"
      style={{ width: "100%" }}
      disabled={saving || !canEdit}
      value={ticket.automationPlanCompleteTime ? dayjs(ticket.automationPlanCompleteTime) : null}
      onChange={(d) => commit(d ? d.format("YYYY-MM-DD") : null)}
    />
  );
}

function InlineCompletionStatusSelect({ ticket, onSaved }: { ticket: Ticket; onSaved: () => void }) {
  const { user } = useAuthStore();
  const canEdit = useCanEdit(ticket);
  const [saving, setSaving] = useState(false);

  async function commit(next: string) {
    if (!user || next === ticket.completionStatus) return;
    setSaving(true);
    try {
      await patchTicket(ticket, "completionStatus", next, user.name, user.role);
      onSaved();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Select
      size="small"
      allowClear
      style={{ width: "100%" }}
      disabled={saving || !canEdit}
      placeholder="未填写"
      options={COMPLETION_OPTIONS}
      value={ticket.completionStatus || undefined}
      onChange={(v) => commit(v ?? "")}
      onClear={() => commit("")}
    />
  );
}

function InlineRemarkInput({ ticket, onSaved }: { ticket: Ticket; onSaved: () => void }) {
  const { user } = useAuthStore();
  const canEdit = useCanEdit(ticket);
  const [value, setValue] = useState(ticket.remark);
  const [saving, setSaving] = useState(false);

  useEffect(() => setValue(ticket.remark), [ticket.remark]);

  async function commit() {
    if (!user || value === ticket.remark) return;
    setSaving(true);
    try {
      await patchTicket(ticket, "remark", value, user.name, user.role);
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
      disabled={saving || !canEdit}
      placeholder="填写备注"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onPressEnter={(e) => (e.target as HTMLInputElement).blur()}
    />
  );
}

function InlineSpentHoursInput({ ticket, onSaved }: { ticket: Ticket; onSaved: () => void }) {
  const { user } = useAuthStore();
  const canEdit = useCanEdit(ticket);
  const [value, setValue] = useState<number | null>(ticket.spentHours);
  const [saving, setSaving] = useState(false);

  useEffect(() => setValue(ticket.spentHours), [ticket.spentHours]);

  async function commit() {
    if (!user || value === ticket.spentHours) return;
    setSaving(true);
    try {
      await patchTicket(ticket, "spentHours", value, user.name, user.role);
      onSaved();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "保存失败");
      setValue(ticket.spentHours);
    } finally {
      setSaving(false);
    }
  }

  return (
    <InputNumber
      size="small"
      style={{ width: "100%" }}
      disabled={saving || !canEdit}
      min={0}
      step={0.5}
      placeholder="未填写"
      value={value ?? undefined}
      onChange={(v) => setValue(v ?? null)}
      onBlur={commit}
      onPressEnter={commit}
    />
  );
}

// 缺陷跟进：工单中心的一个专属视角，固定只看"分类=缺陷"的工单，只展示同事关心的几列
export default function DefectTracking() {
  const { refreshTick } = useOutletContext<{ refreshTick: number }>();
  const [extraFilters, setExtraFilters] = useState<
    Omit<TicketFilters, "scope" | "sortField" | "sortOrder" | "viewTargets">
  >({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const { user } = useAuthStore();
  // 正在导出的菜单项 key，用于给「导出」按钮加 loading，避免大数据量时以为没点上而重复点
  const [exporting, setExporting] = useState<string | null>(null);
  // 提交时间排序，默认倒序（最新的在前）
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [columnOrder, setColumnOrder] = useState<string[]>(loadColumnOrder);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(columnOrder));
  }, [columnOrder]);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setColumnOrder((prev) => arrayMove(prev, prev.indexOf(String(active.id)), prev.indexOf(String(over.id))));
    }
  }

  // 头部「切换人员」选中的人：按受理人或发起人筛，跟本页可见范围口径一致
  const { targets } = useViewTargetStore();
  useEffect(() => {
    setPage(1);
  }, [targets]);

  // 显示哪些分类不写死在这里，由「取数与显示范围 → 缺陷跟进显示分类」配置决定（scope=defect）
  const filters: TicketFilters = {
    ...extraFilters,
    scope: "defect",
    viewTargets: targets.length ? targets : undefined,
    sortField: "submittedAt",
    sortOrder,
  };

  const { data, total, facets, loading, reload } = useTickets(filters, page, pageSize, refreshTick);

  function setFilter<K extends keyof typeof extraFilters>(key: K, value: (typeof extraFilters)[K]) {
    setExtraFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  }

  // all=按当前筛选全量导出（单个 xlsx）；itHandler/requester=按人分组，每人一个文件打成 zip。
  // 导出列与本页列表的表头一致（见后端 DEFECT_COLUMNS），不是工单中心那套全字段
  async function handleExport(key: "all" | "itHandler" | "requester") {
    // filters.scope 是列表接口用的取数口径，跟导出接口的 scope（all/selected）不是一回事，
    // 必须摘掉再传，否则会被后端当成导出模式误判
    const { scope: _scope, ...rest } = filters;
    const body: Record<string, unknown> = { ...rest, view: "defect", actor: user?.name, actorRole: user?.role };
    if (key === "all") body.scope = "all";
    else body.groupBy = key;

    setExporting(key);
    try {
      const res = await api.post("/export", body, { responseType: "blob" });
      const disposition = res.headers["content-disposition"] as string | undefined;
      const matched = disposition?.match(/filename="?([^";]+)"?/);
      const isZip = key !== "all";
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = matched ? decodeURIComponent(matched[1]) : `IT二部缺陷数据.${isZip ? "zip" : "xlsx"}`;
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

  const columnDefs: Record<string, ColumnType<Ticket>> = {
    owningApp: { title: "归属应用", dataIndex: "owningApp", width: 150, ellipsis: true },
    requester: { title: "发起人", dataIndex: "requester", width: 90 },
    itHandler: { title: "受理人", dataIndex: "itHandler", width: 90 },
    status: { title: "状态", dataIndex: "status", width: 100 },
    title: {
      title: "标题",
      dataIndex: "title",
      width: 260,
      ellipsis: { showTitle: false },
      render: (title: string) => <ExpandableCell text={title} />,
    },
    content: {
      title: "内容",
      dataIndex: "content",
      width: 300,
      ellipsis: { showTitle: false },
      render: (content: string) => <ExpandableCell text={content} />,
    },
    submittedAt: {
      title: "创建时间",
      dataIndex: "submittedAt",
      width: 140,
      // 唯一可排序的列，默认倒序；排序在后端做，翻页后依然是全量排序的结果。
      // sortDirections 必须把 descend 放前面：默认就是倒序，用 antd 默认的
      // ascend→descend 次序的话，第一次点击等于没变化
      sorter: true,
      sortDirections: ["descend", "ascend"] as const,
      sortOrder: sortOrder === "asc" ? ("ascend" as const) : ("descend" as const),
    },
    hasTestCase: {
      title: "是否有测试用例",
      width: 130,
      render: (_: unknown, r: Ticket) => <InlineBooleanSelect ticket={r} field="hasTestCase" onSaved={reload} />,
    },
    testCaseSupplemented: {
      title: "是否已补充测试用例",
      width: 150,
      render: (_: unknown, r: Ticket) => (
        <InlineBooleanSelect ticket={r} field="testCaseSupplemented" onSaved={reload} />
      ),
    },
    hasAutomatedTest: {
      title: "是否做自动化测试",
      width: 140,
      render: (_: unknown, r: Ticket) => <InlineBooleanSelect ticket={r} field="hasAutomatedTest" onSaved={reload} />,
    },
    automationPlanCompleteTime: {
      title: "自动化计划完成时间",
      width: 150,
      render: (_: unknown, r: Ticket) => <InlineDatePicker ticket={r} onSaved={reload} />,
    },
    completionStatus: {
      title: "完成情况",
      width: 110,
      render: (_: unknown, r: Ticket) => <InlineCompletionStatusSelect ticket={r} onSaved={reload} />,
    },
    spentHours: {
      title: "花费工时",
      width: 100,
      render: (_: unknown, r: Ticket) => <InlineSpentHoursInput ticket={r} onSaved={reload} />,
    },
    remark: {
      title: "备注",
      width: 180,
      render: (_: unknown, r: Ticket) => <InlineRemarkInput ticket={r} onSaved={reload} />,
    },
  };

  // 编号固定在最左侧不参与拖拽（跟工单中心一致：它是这行的身份，挪走会很难认）
  const columns: ColumnsType<Ticket> = [
    {
      title: "编号",
      dataIndex: "code",
      key: "code",
      width: 150,
      fixed: "left" as const,
      render: (code: string) => (
        <Space size={4}>
          <span>{code}</span>
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
    ...columnOrder.map((key) => ({ ...columnDefs[key], key })),
  ].map((col: any) => ({
    ...col,
    onHeaderCell: (column: any) => ({
      // 只有中间这些列可拖拽调序，编号列不给 columnKey 即不可拖
      columnKey: column.key === "code" ? undefined : column.key,
      resizeKey: column.key,
      width: column.width,
    }),
  })) as ColumnsType<Ticket>;

  const scrollX = columns.reduce((sum, c: any) => sum + (typeof c.width === "number" ? c.width : 120), 0);

  return (
    <div>
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap size={[6, 6]}>
          <Input
            size="small"
            allowClear
            style={{ width: 240 }}
            prefix={<SearchOutlined />}
            placeholder="搜索编号/标题/内容/人员"
            value={extraFilters.search}
            onChange={(e) => setFilter("search", e.target.value || undefined)}
          />
          <Select
            size="small"
            mode="multiple"
            allowClear
            placeholder="分类"
            style={{ minWidth: 110 }}
            showSearch
            options={facets.categories.map((v) => ({ value: v, label: v }))}
            value={extraFilters.category}
            onChange={(v) => setFilter("category", v.length ? v : undefined)}
            maxTagCount={1}
          />
          <Select
            size="small"
            mode="multiple"
            allowClear
            placeholder="归属应用"
            style={{ minWidth: 140 }}
            showSearch
            options={facets.owningApps.map((v) => ({ value: v, label: v }))}
            value={extraFilters.owningApp}
            onChange={(v) => setFilter("owningApp", v.length ? v : undefined)}
            maxTagCount={1}
          />
          <Select
            size="small"
            mode="multiple"
            allowClear
            placeholder="发起人"
            style={{ minWidth: 100 }}
            showSearch
            options={facets.requesters.map((v) => ({ value: v, label: v }))}
            value={extraFilters.requester}
            onChange={(v) => setFilter("requester", v.length ? v : undefined)}
            maxTagCount={1}
          />
          <Select
            size="small"
            mode="multiple"
            allowClear
            placeholder="受理人"
            style={{ minWidth: 100 }}
            showSearch
            options={facets.itHandlers.map((v) => ({ value: v, label: v }))}
            value={extraFilters.itHandler}
            onChange={(v) => setFilter("itHandler", v.length ? v : undefined)}
            maxTagCount={1}
          />
          <Select
            size="small"
            mode="multiple"
            allowClear
            placeholder="状态"
            style={{ minWidth: 100 }}
            options={STATUS_OPTIONS}
            value={extraFilters.status}
            onChange={(v) => setFilter("status", v.length ? v : undefined)}
            maxTagCount={1}
          />
          <RangePicker
            size="small"
            placeholder={["创建时间起", "创建时间止"]}
            value={
              extraFilters.submittedFrom || extraFilters.submittedTo
                ? [
                    extraFilters.submittedFrom ? dayjs(extraFilters.submittedFrom) : null,
                    extraFilters.submittedTo ? dayjs(extraFilters.submittedTo) : null,
                  ]
                : null
            }
            onChange={(vals) => {
              setExtraFilters((f) => ({
                ...f,
                submittedFrom: vals?.[0] ? vals[0].format("YYYY-MM-DD") : undefined,
                submittedTo: vals?.[1] ? vals[1].format("YYYY-MM-DD 23:59") : undefined,
              }));
              setPage(1);
            }}
          />
          <Select
            size="small"
            mode="multiple"
            allowClear
            placeholder="是否有测试用例"
            style={{ minWidth: 150 }}
            options={YES_NO_FILTER_OPTIONS}
            value={extraFilters.hasTestCase}
            onChange={(v) => setFilter("hasTestCase", v.length ? v : undefined)}
            maxTagCount={1}
          />
          <Select
            size="small"
            mode="multiple"
            allowClear
            placeholder="是否已补充测试用例"
            style={{ minWidth: 170 }}
            options={YES_NO_FILTER_OPTIONS}
            value={extraFilters.testCaseSupplemented}
            onChange={(v) => setFilter("testCaseSupplemented", v.length ? v : undefined)}
            maxTagCount={1}
          />
          <Select
            size="small"
            mode="multiple"
            allowClear
            placeholder="是否做自动化测试"
            style={{ minWidth: 160 }}
            options={YES_NO_FILTER_OPTIONS}
            value={extraFilters.hasAutomatedTest}
            onChange={(v) => setFilter("hasAutomatedTest", v.length ? v : undefined)}
            maxTagCount={1}
          />
          <RangePicker
            size="small"
            placeholder={["自动化计划起", "自动化计划止"]}
            value={
              extraFilters.automationFrom || extraFilters.automationTo
                ? [
                    extraFilters.automationFrom ? dayjs(extraFilters.automationFrom) : null,
                    extraFilters.automationTo ? dayjs(extraFilters.automationTo) : null,
                  ]
                : null
            }
            onChange={(vals) => {
              setExtraFilters((f) => ({
                ...f,
                automationFrom: vals?.[0] ? vals[0].format("YYYY-MM-DD") : undefined,
                automationTo: vals?.[1] ? vals[1].format("YYYY-MM-DD") : undefined,
              }));
              setPage(1);
            }}
          />
          <Select
            size="small"
            mode="multiple"
            allowClear
            placeholder="完成情况"
            style={{ minWidth: 120 }}
            options={COMPLETION_FILTER_OPTIONS}
            value={extraFilters.completionStatus}
            onChange={(v) => setFilter("completionStatus", v.length ? v : undefined)}
            maxTagCount={1}
          />
          <Space.Compact>
            <InputNumber
              size="small"
              style={{ width: 100 }}
              min={0}
              step={0.5}
              placeholder="工时≥"
              value={extraFilters.spentHoursMin ?? undefined}
              onChange={(v) => setFilter("spentHoursMin", v ?? undefined)}
            />
            <InputNumber
              size="small"
              style={{ width: 100 }}
              min={0}
              step={0.5}
              placeholder="工时≤"
              value={extraFilters.spentHoursMax ?? undefined}
              onChange={(v) => setFilter("spentHoursMax", v ?? undefined)}
            />
          </Space.Compact>
          <Button
            size="small"
            onClick={() => {
              setExtraFilters({});
              setPage(1);
            }}
          >
            清除筛选
          </Button>
          <Dropdown
            menu={{
              items: [
                { key: "all", label: "全量导出（按当前筛选）" },
                { type: "divider" },
                { key: "itHandler", label: "按受理人导出" },
                { key: "requester", label: "按发起人导出" },
              ],
              onClick: ({ key }) => handleExport(key as "all" | "itHandler" | "requester"),
            }}
            trigger={["click"]}
          >
            <Button size="small" icon={<ExportOutlined />} loading={!!exporting}>
              导出
            </Button>
          </Dropdown>
        </Space>
      </Card>

      <Card size="small">
        <DndContext sensors={sensors} modifiers={[restrictToHorizontalAxis]} onDragEnd={handleDragEnd}>
          <SortableContext items={columnOrder} strategy={horizontalListSortingStrategy}>
            <Table
              rowKey="id"
              size="small"
              loading={loading}
              dataSource={data}
              columns={columns}
              pagination={false}
              scroll={{ x: scrollX }}
              components={{ header: { cell: DraggableHeaderCell } }}
              onChange={(_, __, sorter: any) => {
                // 点到第三下清空排序时，antd 给回的 sorter 里 field/columnKey 都是空的，
                // 所以这里只在"明确是别的列"时才跳过，字段为空一律按提交时间处理
                const key = sorter?.columnKey ?? sorter?.field;
                if (key && key !== "submittedAt") return;
                // antd 点到第三下会把 order 清成 undefined。这里不允许"不排序"这个状态
                // （列表本来就得有个确定顺序），清空时直接翻转成另一个方向
                setSortOrder((prev) =>
                  sorter.order === "ascend"
                    ? "asc"
                    : sorter.order === "descend"
                      ? "desc"
                      : prev === "asc"
                        ? "desc"
                        : "asc"
                );
                setPage(1);
              }}
            />
          </SortableContext>
        </DndContext>
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
      </Card>
    </div>
  );
}
