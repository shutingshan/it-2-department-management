import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Alert, Button, Card, Col, Modal, Row, Select, Space, Table, Tag, Typography, message } from "antd";
import { ExportOutlined } from "@ant-design/icons";
import { api } from "../../api/client";
import { useAuthStore } from "../../store/auth";
import "./RequirementAnalysis.css";

type Frequency = "高频" | "正常" | "低频";

interface TicketDetail {
  code: string;
  owningApp: string;
  module: string;
  status: string;
  expectedCompleteTime: string | null;
  actualCompleteTime: string | null;
  itHandler: string;
  requester: string;
  timePoint: string;
  fromOwningApp: boolean;
}

interface ModuleRow {
  module: string;
  count: number;
  firstTime: string;
  lastTime: string;
  avgIntervalDays: number | null;
  frequency: Frequency;
  fromOwningApp: boolean;
  tickets: TicketDetail[];
}

interface Stats {
  rows: ModuleRow[];
  years: number[];
  total: number;
  doneCount: number;
  undoneCount: number;
  excludedNoTime: number;
  summary: Record<Frequency, number>;
}

const FREQ_COLORS: Record<Frequency, string> = { 高频: "red", 正常: "blue", 低频: "default" };

// 频率档位的判定口径，直接写在页面上，免得汇报时说不清数字怎么来的
const RULE_TEXT =
  "统计范围：库内分类为「需求」，且状态不为「关闭」「新制」的工单。" +
  "时间点取法：状态为已解决/已完成的取「实际完成时间」，其余取「预计完成时间」。" +
  "需求模块带「/」时只取最后一级；需求模块为空时改按「归属应用」统计（表格里会标注）。" +
  "平均间隔 =（最晚时间点 − 最早时间点）÷（条数 − 1）。" +
  "高频：平均间隔 < 1 个月且条数 ≥ 2；正常：1~3 个月且条数 ≥ 2；低频：间隔 > 3 个月，或该模块只有 1 条需求。" +
  "（1 个月按 30 天换算）";

export default function RequirementAnalysis() {
  const { user } = useAuthStore();
  const canAccess =
    user?.role === "admin" || (user?.menuPermissions ?? []).includes("requirementAnalysis");

  const [year, setYear] = useState<string>("all");
  const [data, setData] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  // 点某一行打开该模块的工单明细
  const [detailOf, setDetailOf] = useState<ModuleRow | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const res = await api.get("/stats/requirement-modules", {
        params: { actor: user.name, year },
      });
      setData(res.data.data);
    } finally {
      setLoading(false);
    }
  }, [user, year]);

  useEffect(() => {
    if (canAccess) load();
  }, [canAccess, load]);

  // 不传 module 导模块汇总表，传了则导该模块的工单明细
  async function handleExport(module?: string) {
    if (!user) return;
    setExporting(true);
    try {
      const res = await api.post(
        "/export",
        {
          view: "requirementModules",
          actor: user.name,
          year: year === "all" ? undefined : year,
          module,
        },
        { responseType: "blob" }
      );
      const disposition = res.headers["content-disposition"] as string | undefined;
      const matched = disposition?.match(/filename="?([^";]+)"?/);
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = matched ? decodeURIComponent(matched[1]) : "IT二部需求模块分析.xlsx";
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
      setExporting(false);
    }
  }

  if (!canAccess) return <Navigate to="/tickets" replace />;

  return (
    <div className="req-analysis-page">
      <div className="req-analysis-header">
        <Space>
          <Typography.Text strong>统计范围</Typography.Text>
          <Select
            size="small"
            style={{ width: 140 }}
            value={year}
            onChange={setYear}
            options={[
              { value: "all", label: "整体（全部年份）" },
              ...(data?.years ?? []).map((y) => ({ value: String(y), label: `${y} 年` })),
            ]}
          />
        </Space>
        <Button size="small" icon={<ExportOutlined />} loading={exporting} onClick={() => handleExport()}>
          导出
        </Button>
      </div>

      <Alert className="req-analysis-summary" type="info" showIcon message={RULE_TEXT} />

      {data && data.excludedNoTime > 0 && (
        <Alert
          className="req-analysis-summary"
          type="warning"
          showIcon
          message={`有 ${data.excludedNoTime} 条需求工单因为「实际完成时间」与「预计完成时间」都为空，落不到时间轴上，未纳入统计。`}
        />
      )}

      <Row gutter={12} className="req-analysis-summary">
        {[
          { label: "需求总条数", value: data?.total ?? 0, hint: "纳入统计的需求工单数" },
          { label: "完成条数", value: data?.doneCount ?? 0, hint: "状态为已完成 / 已解决" },
          { label: "未完成条数", value: data?.undoneCount ?? 0, hint: "非已完成、非已解决" },
        ].map((c) => (
          <Col key={c.label} span={8}>
            <Card size="small">
              <Typography.Text type="secondary">{c.label}</Typography.Text>
              <div style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.3 }}>{c.value}</div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {c.hint}
              </Typography.Text>
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={12} className="req-analysis-section">
        {(["高频", "正常", "低频"] as Frequency[]).map((f) => (
          <Col key={f} span={8}>
            <Card size="small">
              <Typography.Text type="secondary">{f}模块数</Typography.Text>
              <div style={{ fontSize: 24, fontWeight: 600 }}>{data?.summary?.[f] ?? 0}</div>
            </Card>
          </Col>
        ))}
      </Row>

      <Typography.Title level={5}>图表1 · 需求模块改动频率</Typography.Title>
      <Table
        rowKey="module"
        size="small"
        loading={loading}
        dataSource={data?.rows ?? []}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 个模块` }}
        locale={{ emptyText: "当前范围内没有需求数据" }}
        onRow={(r: ModuleRow) => ({
          onClick: () => setDetailOf(r),
          style: { cursor: "pointer" },
        })}
        columns={[
          {
            title: "需求模块",
            dataIndex: "module",
            width: 220,
            ellipsis: true,
            render: (v: string, r: ModuleRow) => (
              <Space size={4}>
                <a>{v}</a>
                {/* 这一行的模块名是拿归属应用顶上的，标出来免得被当成数据错了 */}
                {r.fromOwningApp && <Tag>归属应用</Tag>}
              </Space>
            ),
          },
          {
            title: "需求条数",
            dataIndex: "count",
            width: 100,
            sorter: (a: ModuleRow, b: ModuleRow) => a.count - b.count,
          },
          { title: "最早时间点", dataIndex: "firstTime", width: 120 },
          { title: "最晚时间点", dataIndex: "lastTime", width: 120 },
          {
            title: "平均间隔（天）",
            dataIndex: "avgIntervalDays",
            width: 130,
            sorter: (a: ModuleRow, b: ModuleRow) =>
              (a.avgIntervalDays ?? Infinity) - (b.avgIntervalDays ?? Infinity),
            render: (v: number | null) => v ?? "-",
          },
          {
            title: "频率",
            dataIndex: "frequency",
            width: 90,
            filters: (["高频", "正常", "低频"] as Frequency[]).map((f) => ({ text: f, value: f })),
            onFilter: (v: any, r: ModuleRow) => r.frequency === v,
            render: (f: Frequency) => <Tag color={FREQ_COLORS[f]}>{f}</Tag>,
          },
        ]}
      />

      <Modal
        open={!!detailOf}
        onCancel={() => setDetailOf(null)}
        width={1000}
        title={
          detailOf
            ? `需求明细 · ${detailOf.module}（${detailOf.tickets.length} 条 · ${detailOf.frequency}）`
            : "需求明细"
        }
        footer={
          <Space>
            <Button
              icon={<ExportOutlined />}
              loading={exporting}
              onClick={() => detailOf && handleExport(detailOf.module)}
            >
              导出明细
            </Button>
            <Button onClick={() => setDetailOf(null)}>关闭</Button>
          </Space>
        }
      >
        <Table
          rowKey="code"
          size="small"
          dataSource={detailOf?.tickets ?? []}
          pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
          scroll={{ x: 900 }}
          columns={[
            { title: "工单编码", dataIndex: "code", width: 140 },
            { title: "归属应用", dataIndex: "owningApp", width: 120, ellipsis: true },
            {
              title: "需求模块",
              dataIndex: "module",
              width: 160,
              ellipsis: true,
              render: (v: string, r: TicketDetail) => (
                <Space size={4}>
                  <span>{v}</span>
                  {r.fromOwningApp && <Tag>归属应用</Tag>}
                </Space>
              ),
            },
            { title: "状态", dataIndex: "status", width: 90 },
            {
              title: "期望完成时间",
              dataIndex: "expectedCompleteTime",
              width: 120,
              render: (v: string | null) => v ?? "-",
            },
            {
              title: "实际完成时间",
              dataIndex: "actualCompleteTime",
              width: 120,
              render: (v: string | null) => v ?? "-",
            },
            { title: "IT受理人", dataIndex: "itHandler", width: 100 },
            { title: "发起人", dataIndex: "requester", width: 100 },
            {
              // 两个完成时间都有值时，看这一列才知道这条按哪个日期参与的频率计算
              title: "统计时间点",
              dataIndex: "timePoint",
              width: 120,
            },
          ]}
        />
      </Modal>
    </div>
  );
}
