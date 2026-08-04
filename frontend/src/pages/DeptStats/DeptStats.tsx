import { useEffect, useMemo, useState } from "react";
import { Card, Col, Row, Select, Table, TreeSelect } from "antd";
import Chart from "../../components/Chart";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import StatCard from "../../components/StatCard";

const YEARS = ["2024", "2025", "2026", "all"];

export default function DeptStats() {
  const navigate = useNavigate();
  const [year, setYear] = useState("all");
  // 月度部门工时占比/趋势图后端固定按2026年切片（未选具体年份时的口径，
  // 跟"父级部门月度提交及完成趋势"一致），这里只是决定图表标题怎么显示
  const ratioYearLabel = year === "all" ? "2026" : year;
  const [deptIds, setDeptIds] = useState<string[]>([]);
  const [data, setData] = useState<any>(null);
  const [activeChart, setActiveChart] = useState<string | null>(null);

  useEffect(() => {
    api
      .get("/stats/departments", { params: { year, deptIds: deptIds.length ? deptIds.join(",") : undefined } })
      .then((res) => setData(res.data));
  }, [year, deptIds]);

  const treeData = useMemo(() => {
    if (!data) return [];
    const roots = data.departments.filter((d: any) => d.parentId === null);
    return roots.map((r: any) => ({
      title: r.name,
      value: r.id,
      key: r.id,
      children: data.departments
        .filter((d: any) => d.parentId === r.id)
        .map((c: any) => ({ title: c.name, value: c.id, key: c.id })),
    }));
  }, [data]);

  const trendOption = useMemo(() => {
    if (!data) return {};
    return {
      tooltip: { trigger: "axis" },
      legend: { data: ["提交", "完成"] },
      xAxis: { type: "category", data: data.monthlyTrend.map((m: any) => `${m.month}月`) },
      yAxis: { type: "value" },
      series: [
        { name: "提交", type: "line", data: data.monthlyTrend.map((m: any) => m.submitted) },
        { name: "完成", type: "line", data: data.monthlyTrend.map((m: any) => m.completed) },
      ],
    };
  }, [data]);

  const spentPieOption = useMemo(() => {
    if (!data) return {};
    return {
      tooltip: { trigger: "item" },
      legend: { bottom: 0 },
      series: [
        {
          type: "pie",
          radius: ["40%", "70%"],
          data: data.spentHoursRatio.map((d: any) => ({ name: d.deptName, value: d.value })),
          label: { formatter: "{b}: {c}" },
        },
      ],
    };
  }, [data]);

  const estPieOption = useMemo(() => {
    if (!data) return {};
    return {
      tooltip: { trigger: "item" },
      legend: { bottom: 0 },
      series: [
        {
          type: "pie",
          radius: ["40%", "70%"],
          data: data.estimatedHoursRatio.map((d: any) => ({ name: d.deptName, value: d.value })),
          label: { formatter: "{b}: {c}" },
        },
      ],
    };
  }, [data]);

  // 各部门月度工时花费占比：100%堆叠柱状图，每个月柱子总高度都是100%，
  // 看的是部门之间的占比结构随月份如何变化，不是绝对工时数值
  const monthlyShareOption = (series: any[]) => ({
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, valueFormatter: (v: number) => `${v}%` },
    legend: { bottom: 0 },
    xAxis: { type: "category", data: Array.from({ length: 12 }, (_, i) => `${i + 1}月`) },
    yAxis: { type: "value", max: 100, axisLabel: { formatter: "{value}%" } },
    series: series.map((d) => ({
      name: d.deptName,
      type: "bar",
      stack: "total",
      data: d.values,
    })),
  });

  const monthlySpentShareOption = useMemo(
    () => (data ? monthlyShareOption(data.monthlySpentSharePercent) : {}),
    [data]
  );
  const monthlyEstimatedShareOption = useMemo(
    () => (data ? monthlyShareOption(data.monthlyEstimatedSharePercent) : {}),
    [data]
  );

  if (!data) return null;

  return (
    <div>
      <div style={{ marginBottom: 12, display: "flex", gap: 12 }}>
        <TreeSelect
          treeCheckable
          allowClear
          style={{ minWidth: 260 }}
          placeholder="选择父级/子级部门（可搜索、多选）"
          treeData={treeData}
          value={deptIds}
          onChange={setDeptIds}
          showSearch
          treeNodeFilterProp="title"
        />
        <Select
          value={year}
          onChange={setYear}
          options={YEARS.map((y) => ({ value: y, label: y === "all" ? "全部年份" : y }))}
          style={{ width: 120 }}
        />
      </div>

      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={6}>
          <StatCard title="工单总数" value={data.cards.total} />
        </Col>
        <Col span={6}>
          <StatCard title="完成数/关闭数" value={`${data.cards.completed} / ${data.cards.closed}`} />
        </Col>
        <Col span={6}>
          <StatCard title="未完成数" value={data.cards.incomplete} color="#d4380d" />
        </Col>
        <Col span={6}>
          <StatCard
            title="已花费/预估花费工时"
            value={`${data.cards.spentHours} / ${data.cards.estimatedSpentHours}`}
          />
        </Col>
      </Row>

      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={12}>
          <Card size="small" title="父级部门月度提交及完成趋势">
            <Chart
              option={trendOption}
              style={{ height: 240 }}
              onEvents={{
                click: () => setActiveChart(activeChart === "trend" ? null : "trend"),
              }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" title="已花费工时占比">
            <Chart option={spentPieOption} style={{ height: 240 }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" title="预估花费工时占比">
            <Chart option={estPieOption} style={{ height: 240 }} />
          </Card>
        </Col>
      </Row>

      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={12}>
          <Card size="small" title={`各部门月度已花费实际工时占比（按${ratioYearLabel}年）`}>
            <Chart option={monthlySpentShareOption} style={{ height: 260 }} />
          </Card>
        </Col>
        <Col span={12}>
          <Card size="small" title={`各部门月度预估花费工时占比（按${ratioYearLabel}年）`}>
            <Chart option={monthlyEstimatedShareOption} style={{ height: 260 }} />
          </Card>
        </Col>
      </Row>

      <Card size="small" title="部门明细">
        <Table
          size="small"
          rowKey="deptId"
          dataSource={data.byDept}
          pagination={false}
          onRow={(r: any) => ({
            onClick: () => navigate("/tickets", { state: { requesterDept: [r.deptId] } }),
          })}
          columns={[
            { title: "部门", dataIndex: "deptName" },
            { title: "工单总数", dataIndex: "total" },
            { title: "完成数", dataIndex: "completed" },
            { title: "关闭数", dataIndex: "closed" },
            { title: "未完成数", dataIndex: "incomplete" },
            { title: "已花费工时", dataIndex: "spentHours" },
            { title: "预估花费工时", dataIndex: "estimatedSpentHours" },
          ]}
        />
      </Card>
    </div>
  );
}
