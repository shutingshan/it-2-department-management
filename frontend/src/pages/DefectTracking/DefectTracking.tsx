import { useState } from "react";
import { Button, Card, Input, Pagination, Popover, Select, Space, Table } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import type { Ticket } from "../../api/types";
import { TICKET_STATUSES } from "../../api/types";
import { useOutletContext } from "react-router-dom";
import { useTickets } from "../TicketCenter/useTickets";
import type { TicketFilters } from "../TicketCenter/useTickets";

const STATUS_OPTIONS = TICKET_STATUSES.map((v) => ({ value: v, label: v }));

// 标题/内容较长，单元格省略号截断，点击后弹出完整内容
function ExpandableCell({ text }: { text: string }) {
  return (
    <Popover trigger="click" placement="bottomLeft" content={<div style={{ maxWidth: 420 }}>{text || "-"}</div>}>
      <span style={{ cursor: "pointer" }}>{text}</span>
    </Popover>
  );
}

// 缺陷跟进：工单中心的一个专属视角，固定只看"分类=缺陷"的工单，只展示同事关心的几列
export default function DefectTracking() {
  const { refreshTick } = useOutletContext<{ refreshTick: number }>();
  const [extraFilters, setExtraFilters] = useState<Omit<TicketFilters, "category" | "sortField" | "sortOrder">>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const filters: TicketFilters = {
    ...extraFilters,
    category: ["缺陷"],
    sortField: "submittedAt",
    sortOrder: "desc",
  };

  const { data, total, facets, loading } = useTickets(filters, page, pageSize, refreshTick);

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
  ];

  return (
    <div>
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap size={[6, 6]}>
          <Input
            size="small"
            allowClear
            style={{ width: 260 }}
            prefix={<SearchOutlined />}
            placeholder="搜索标题/内容"
            value={extraFilters.search}
            onChange={(e) => setFilter("search", e.target.value || undefined)}
          />
          <Select
            size="small"
            mode="multiple"
            allowClear
            placeholder="归属应用"
            style={{ minWidth: 150 }}
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
            placeholder="状态"
            style={{ minWidth: 100 }}
            options={STATUS_OPTIONS}
            value={extraFilters.status}
            onChange={(v) => setFilter("status", v.length ? v : undefined)}
            maxTagCount={1}
          />
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
