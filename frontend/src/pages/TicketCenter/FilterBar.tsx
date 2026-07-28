import type { ReactNode } from "react";
import { DatePicker, Input, Select, Space, Button } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import type { Facets, TicketFilters } from "./useTickets";

const YES_NO_OPTIONS = [
  { value: "yes", label: "是" },
  { value: "no", label: "否" },
];

// 是/否类多选框只有单一有效取值：两个都选或都不选时等同于不筛选
function yesNoValueToBool(v: string[]): boolean | undefined {
  if (v.includes("yes") && !v.includes("no")) return true;
  if (v.includes("no") && !v.includes("yes")) return false;
  return undefined;
}
function boolToYesNoValue(v: boolean | undefined): string[] {
  if (v === true) return ["yes"];
  if (v === false) return ["no"];
  return [];
}

const { RangePicker } = DatePicker;

const STAGE_OPTIONS = [
  "待分配",
  "待补充资料",
  "方案梳理",
  "待排期",
  "已排期",
  "开发中",
  "测试验收",
  "已完成",
  "关闭",
].map((v) => ({
  value: v,
  label: v,
}));
const STATUS_OPTIONS = [
  "待处理",
  "梳理中",
  "已梳理",
  "规划中",
  "开发完成",
  "实现中",
  "转测试",
  "测试中",
  "待验收",
  "已验收",
  "已解决",
  "已完成",
  "关闭",
].map((v) => ({ value: v, label: v }));

export default function FilterBar({
  filters,
  onChange,
  facets,
  extra,
  rightExtra,
}: {
  filters: TicketFilters;
  onChange: (f: TicketFilters) => void;
  facets: Facets;
  extra?: ReactNode;
  rightExtra?: ReactNode;
}) {
  function set<K extends keyof TicketFilters>(key: K, value: TicketFilters[K]) {
    onChange({ ...filters, [key]: value });
  }

  function clearAll() {
    onChange({ sortField: "submittedAt", sortOrder: "desc" });
  }

  return (
    <div className="filter-bar">
      <Space wrap size={[6, 6]} className="filter-bar-controls">
        <Input
          size="small"
          allowClear
          style={{ width: 260 }}
          prefix={<SearchOutlined />}
          placeholder="搜索编号/标题/内容/发起人/处理人/TAPD地址"
          value={filters.search}
          onChange={(e) => set("search", e.target.value || undefined)}
        />
        <Select
          size="small"
          mode="multiple"
          allowClear
          placeholder="工单阶段"
          style={{ minWidth: 140 }}
          options={STAGE_OPTIONS}
          value={filters.stage}
          onChange={(v) => set("stage", v.length ? v : undefined)}
          maxTagCount={1}
        />
        <Select
          size="small"
          mode="multiple"
          allowClear
          placeholder="状态"
          style={{ minWidth: 90 }}
          options={STATUS_OPTIONS}
          value={filters.status}
          onChange={(v) => set("status", v.length ? v : undefined)}
          maxTagCount={1}
        />
        <Select
          size="small"
          mode="multiple"
          allowClear
          placeholder="月度计划"
          style={{ minWidth: 130 }}
          options={facets.monthlyPlans.map((v) => ({ value: v, label: v }))}
          value={filters.monthlyPlan}
          onChange={(v) => set("monthlyPlan", v.length ? v : undefined)}
          maxTagCount={1}
        />
        <Select
          size="small"
          mode="multiple"
          allowClear
          placeholder="迭代"
          style={{ minWidth: 130 }}
          options={facets.iterations.map((v) => ({ value: v, label: v }))}
          value={filters.iteration}
          onChange={(v) => set("iteration", v.length ? v : undefined)}
          maxTagCount={1}
        />
        <Select
          size="small"
          mode="multiple"
          allowClear
          placeholder="发起人"
          style={{ minWidth: 90 }}
          showSearch
          options={facets.requesters.map((v) => ({ value: v, label: v }))}
          value={filters.requester}
          onChange={(v) => set("requester", v.length ? v : undefined)}
          maxTagCount={1}
        />
        <Select
          size="small"
          mode="multiple"
          allowClear
          placeholder="关注人"
          style={{ minWidth: 90 }}
          showSearch
          options={facets.watchers.map((v) => ({ value: v, label: v }))}
          value={filters.watcher}
          onChange={(v) => set("watcher", v.length ? v : undefined)}
          maxTagCount={1}
        />
        <Select
          size="small"
          mode="multiple"
          allowClear
          placeholder="归属应用"
          style={{ minWidth: 130 }}
          showSearch
          options={facets.owningApps.map((v) => ({ value: v, label: v }))}
          value={filters.owningApp}
          onChange={(v) => set("owningApp", v.length ? v : undefined)}
          maxTagCount={1}
        />
        <Select
          size="small"
          mode="multiple"
          allowClear
          placeholder="紧急"
          style={{ minWidth: 80 }}
          options={YES_NO_OPTIONS}
          value={boolToYesNoValue(filters.urgent)}
          onChange={(v) => set("urgent", yesNoValueToBool(v))}
          maxTagCount={1}
        />
        <Select
          size="small"
          mode="multiple"
          allowClear
          placeholder="是否有TAPD地址"
          style={{ minWidth: 130 }}
          options={YES_NO_OPTIONS}
          value={boolToYesNoValue(filters.hasTapd)}
          onChange={(v) => set("hasTapd", yesNoValueToBool(v))}
          maxTagCount={1}
        />
        <RangePicker
          size="small"
          placeholder={["提交时间起", "提交时间止"]}
          onChange={(vals) => {
            set("submittedFrom", vals?.[0] ? vals[0].format("YYYY-MM-DD") : undefined);
            set("submittedTo", vals?.[1] ? vals[1].format("YYYY-MM-DD 23:59") : undefined);
          }}
        />
        <Button size="small" onClick={clearAll}>
          清除筛选
        </Button>
        {extra}
      </Space>
      {rightExtra && <div className="filter-bar-right">{rightExtra}</div>}
    </div>
  );
}
