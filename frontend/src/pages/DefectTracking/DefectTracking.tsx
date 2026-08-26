import { useEffect, useState } from "react";
import { Button, Card, DatePicker, Input, InputNumber, Pagination, Popover, Select, Space, Table, message } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import type { Ticket } from "../../api/types";
import { TICKET_STATUSES } from "../../api/types";
import { useOutletContext } from "react-router-dom";
import { api } from "../../api/client";
import { useAuthStore } from "../../store/auth";
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

// 标题/内容较长，单元格省略号截断，点击后弹出完整内容
function ExpandableCell({ text }: { text: string }) {
  return (
    <Popover trigger="click" placement="bottomLeft" content={<div style={{ maxWidth: 420 }}>{text || "-"}</div>}>
      <span style={{ cursor: "pointer" }}>{text}</span>
    </Popover>
  );
}

// IT 受理人仅能编辑本人负责的工单；其余角色不受限，跟工单中心的"紧急/备注"编辑权限一致
function useCanEdit(ticket: Ticket) {
  const { user } = useAuthStore();
  return !(user?.role === "it_handler" && ticket.itHandler !== user.name);
}

async function patchTicket(ticket: Ticket, field: string, value: unknown, actor: string, actorRole: string) {
  await api.patch(`/tickets/${ticket.id}`, { fields: { [field]: value }, actor, actorRole });
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
  const [extraFilters, setExtraFilters] = useState<Omit<TicketFilters, "scope" | "sortField" | "sortOrder">>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // 显示哪些分类不写死在这里，由「取数与显示范围 → 缺陷跟进显示分类」配置决定（scope=defect）
  const filters: TicketFilters = {
    ...extraFilters,
    scope: "defect",
    sortField: "submittedAt",
    sortOrder: "desc",
  };

  const { data, total, facets, loading, reload } = useTickets(filters, page, pageSize, refreshTick);

  function setFilter<K extends keyof typeof extraFilters>(key: K, value: (typeof extraFilters)[K]) {
    setExtraFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  }

  const columns: ColumnsType<Ticket> = [
    { title: "归属应用", dataIndex: "owningApp", width: 150, ellipsis: true },
    { title: "发起人", dataIndex: "requester", width: 90 },
    { title: "受理人", dataIndex: "itHandler", width: 90 },
    { title: "状态", dataIndex: "status", width: 100 },
    {
      title: "标题",
      dataIndex: "title",
      width: 260,
      ellipsis: { showTitle: false },
      render: (title: string) => <ExpandableCell text={title} />,
    },
    {
      title: "内容",
      dataIndex: "content",
      ellipsis: { showTitle: false },
      render: (content: string) => <ExpandableCell text={content} />,
    },
    { title: "创建时间", dataIndex: "submittedAt", width: 140 },
    {
      title: "是否有测试用例",
      width: 110,
      render: (_: unknown, r: Ticket) => <InlineBooleanSelect ticket={r} field="hasTestCase" onSaved={reload} />,
    },
    {
      title: "是否已补充测试用例",
      width: 130,
      render: (_: unknown, r: Ticket) => (
        <InlineBooleanSelect ticket={r} field="testCaseSupplemented" onSaved={reload} />
      ),
    },
    {
      title: "是否做自动化测试",
      width: 120,
      render: (_: unknown, r: Ticket) => <InlineBooleanSelect ticket={r} field="hasAutomatedTest" onSaved={reload} />,
    },
    {
      title: "自动化计划完成时间",
      width: 140,
      render: (_: unknown, r: Ticket) => <InlineDatePicker ticket={r} onSaved={reload} />,
    },
    {
      title: "完成情况",
      width: 110,
      render: (_: unknown, r: Ticket) => <InlineCompletionStatusSelect ticket={r} onSaved={reload} />,
    },
    {
      title: "花费工时",
      width: 100,
      render: (_: unknown, r: Ticket) => <InlineSpentHoursInput ticket={r} onSaved={reload} />,
    },
  ];

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
        </Space>
      </Card>

      <Card size="small">
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={data}
          columns={columns}
          pagination={false}
          scroll={{ x: columns.reduce((sum, c: any) => sum + (typeof c.width === "number" ? c.width : 100), 0) }}
        />
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
