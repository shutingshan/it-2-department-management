import { DatePicker, Input, Select, Space, Switch, Button } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import type { Facets, TicketFilters } from "./useTickets";

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
}: {
  filters: TicketFilters;
  onChange: (f: TicketFilters) => void;
  facets: Facets;
}) {
  function set<K extends keyof TicketFilters>(key: K, value: TicketFilters[K]) {
    onChange({ ...filters, [key]: value });
  }

  function clearAll() {
    onChange({ sortField: "submittedAt", sortOrder: "desc" });
  }

  return (
    <div className="filter-bar">
      <Space wrap size={[8, 8]}>
        <Input
          allowClear
          style={{ width: 260 }}
          prefix={<SearchOutlined />}
          placeholder="搜索编号/标题/内容/发起人/处理人/TAPD地址"
          value={filters.search}
          onChange={(e) => set("search", e.target.value || undefined)}
        />
        <RangePicker
          placeholder={["提交时间起", "提交时间止"]}
          onChange={(vals) => {
            set("submittedFrom", vals?.[0] ? vals[0].format("YYYY-MM-DD") : undefined);
            set("submittedTo", vals?.[1] ? vals[1].format("YYYY-MM-DD 23:59") : undefined);
          }}
        />
        <Select
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
          mode="multiple"
          allowClear
          placeholder="状态"
          style={{ minWidth: 120 }}
          options={STATUS_OPTIONS}
          value={filters.status}
          onChange={(v) => set("status", v.length ? v : undefined)}
          maxTagCount={1}
        />
        <Select
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
          allowClear
          placeholder="发起人"
          style={{ minWidth: 110 }}
          showSearch
          options={facets.requesters.map((v) => ({ value: v, label: v }))}
          value={filters.requester?.[0]}
          onChange={(v) => set("requester", v ? [v] : undefined)}
        />
        <Select
          allowClear
          placeholder="归属应用"
          style={{ minWidth: 110 }}
          showSearch
          options={facets.owningApps.map((v) => ({ value: v, label: v }))}
          value={filters.owningApp?.[0]}
          onChange={(v) => set("owningApp", v ? [v] : undefined)}
        />
        <Space size={4}>
          <span style={{ fontSize: 13, color: "#595959" }}>紧急</span>
          <Switch
            checked={filters.urgent === true}
            onChange={(checked) => set("urgent", checked ? true : undefined)}
          />
        </Space>
        <Button onClick={clearAll}>清除筛选</Button>
      </Space>
    </div>
  );
}
