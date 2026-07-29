import { useEffect, useMemo, useState } from "react";
import { Card, Col, Row, Select, Space, Typography } from "antd";
import ReactECharts from "echarts-for-react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import StatCard from "../../components/StatCard";
import "./Home.css";

const YEARS = ["2024", "2025", "2026", "all"];
// 跟后端 backend/src/routes/stats.ts 里的 ALL_HANDLERS_KEY 保持一致
const ALL_HANDLERS_KEY = "__all__";

export default function Home() {
  const navigate = useNavigate();
  const [year, setYear] = useState("2026");
  const [stats, setStats] = useState<any>(null);
  const [stageDrill, setStageDrill] = useState<string | null>(null);
  const [handlerDrill, setHandlerDrill] = useState<string | null>(null);
  const [selectedHandler, setSelectedHandler] = useState<string | null>(null);
  const [progressYear, setProgressYear] = useState(2026);
  const [progressMonth, setProgressMonth] = useState(7);

  useEffect(() => {
    api.get("/stats/home", { params: { year, progressYear, progressMonth } }).then((res) => {
      setStats(res.data);
      if (!selectedHandler && res.data.handlerRatio[0]) {
        setSelectedHandler(res.data.handlerRatio[0].name);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, progressYear, progressMonth]);

  // 图例项一多（尤其受理人可能有十几个），底部图例换行后容易跟饼图本身或换行后的
  // 图例互相压在一起。改成可滚动的单行图例（超出宽度就分页，鼠标滚轮/箭头翻页），
  // 不再自动换行，同时把饼图整体往上收一点、留出图例的位置
  const pieLegend = { bottom: 0, type: "scroll" as const, itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 11 } };

  const stageOption = useMemo(() => {
    if (!stats) return {};
    return {
      tooltip: { trigger: "item" },
      legend: pieLegend,
      series: [
        {
          name: "工单阶段占比",
          type: "pie",
          radius: ["35%", "60%"],
          center: ["50%", "42%"],
          data: stats.stageRatio.map((s: any) => ({ name: s.stage, value: s.value })),
          label: { formatter: "{b}: {c}" },
        },
      ],
    };
  }, [stats]);

  const handlerOption = useMemo(() => {
    if (!stats) return {};
    return {
      tooltip: { trigger: "item" },
      legend: pieLegend,
      series: [
        {
          name: "受理人工单占比",
          type: "pie",
          radius: ["35%", "60%"],
          center: ["50%", "42%"],
          data: stats.handlerRatio.map((s: any) => ({ name: s.name, value: s.value })),
          label: { formatter: "{b}: {c}" },
        },
      ],
    };
  }, [stats]);

  const stageDrillData = stageDrill
    ? stats?.owningAppDrilldown.find((d: any) => d.stage === stageDrill)?.apps ?? []
    : [];
  const handlerDrillData = handlerDrill
    ? stats?.handlerDeptDrilldown.find((d: any) => d.handler === handlerDrill)?.depts ?? []
    : [];

  const trendOption = useMemo(() => {
    if (!stats || !selectedHandler) return {};
    const row = stats.monthlyTrend.find((m: any) => m.handler === selectedHandler);
    if (!row) return {};
    const labels = row.series.map((s: any) => `${s.year}-${String(s.month).padStart(2, "0")}`);
    return {
      tooltip: { trigger: "axis" },
      legend: { data: ["接收", "完成"] },
      xAxis: { type: "category", data: labels, axisLabel: { rotate: 45, fontSize: 10 } },
      yAxis: { type: "value" },
      series: [
        { name: "接收", type: "line", data: row.series.map((s: any) => s.received) },
        { name: "完成", type: "line", data: row.series.map((s: any) => s.completed) },
      ],
    };
  }, [stats, selectedHandler]);

  if (!stats) return null;

  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <span>年份：</span>
        <Select
          value={year}
          onChange={setYear}
          options={YEARS.map((y) => ({ value: y, label: y === "all" ? "全部" : y }))}
          style={{ width: 100 }}
        />
      </Space>

      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={6}>
          <StatCard title="受理人工单数" value={stats.cards.handlerTotal} />
        </Col>
        <Col span={6}>
          <StatCard title="完成工单数" value={stats.cards.completed} color="#389e0d" />
        </Col>
        <Col span={6}>
          <StatCard title="关闭工单数" value={stats.cards.closed} color="#8c8c8c" />
        </Col>
        <Col span={6}>
          <StatCard title="未完成工单数" value={stats.cards.incomplete} color="#d4380d" />
        </Col>
      </Row>

      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={12}>
          <Card
            size="small"
            title="工单阶段占比（点击下钻归属应用）"
            extra={
              stageDrill && (
                <a onClick={() => setStageDrill(null)}>
                  返回
                </a>
              )
            }
          >
            {!stageDrill ? (
              <ReactECharts
                option={stageOption}
                style={{ height: 260 }}
                onEvents={{
                  click: (p: any) => {
                    setStageDrill(p.name);
                  },
                }}
              />
            ) : (
              <ReactECharts
                option={{
                  tooltip: { trigger: "item" },
                  series: [
                    {
                      type: "pie",
                      radius: ["40%", "70%"],
                      data: stageDrillData.map((d: any) => ({ name: d.owningApp, value: d.value })),
                      label: { formatter: "{b}: {c}" },
                    },
                  ],
                }}
                style={{ height: 260 }}
                onEvents={{
                  click: (p: any) => {
                    navigate("/tickets", { state: { stage: [stageDrill], owningApp: [p.name] } });
                  },
                }}
              />
            )}
          </Card>
        </Col>
        <Col span={12}>
          <Card
            size="small"
            title="受理人工单占比（点击下钻发起部门）"
            extra={handlerDrill && <a onClick={() => setHandlerDrill(null)}>返回</a>}
          >
            {!handlerDrill ? (
              <ReactECharts
                option={handlerOption}
                style={{ height: 260 }}
                onEvents={{ click: (p: any) => setHandlerDrill(p.name) }}
              />
            ) : (
              <ReactECharts
                option={{
                  tooltip: { trigger: "item" },
                  series: [
                    {
                      type: "pie",
                      radius: ["40%", "70%"],
                      data: handlerDrillData.map((d: any) => ({ name: d.dept, value: d.value })),
                      label: { formatter: "{b}: {c}" },
                    },
                  ],
                }}
                style={{ height: 260 }}
                onEvents={{
                  click: () => navigate("/tickets", { state: { itHandler: [handlerDrill] } }),
                }}
              />
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={16}>
          <Card
            size="small"
            title="各受理人过去三年每月接收/完成数量对比"
            extra={
              <Select
                size="small"
                value={selectedHandler}
                onChange={setSelectedHandler}
                options={[
                  { value: ALL_HANDLERS_KEY, label: "全部数据" },
                  ...stats.handlerRatio.map((h: any) => ({ value: h.name, label: h.name })),
                ]}
                style={{ width: 120 }}
              />
            }
          >
            <ReactECharts option={trendOption} style={{ height: 260 }} />
          </Card>
        </Col>
        <Col span={8}>
          <Card
            size="small"
            title="梳理及完成进度"
            extra={
              <Space size={4}>
                <Select
                  size="small"
                  value={progressYear}
                  onChange={setProgressYear}
                  options={[2024, 2025, 2026].map((y) => ({ value: y, label: y }))}
                  style={{ width: 80 }}
                />
                <Select
                  size="small"
                  value={progressMonth}
                  onChange={setProgressMonth}
                  options={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `${i + 1}月` }))}
                  style={{ width: 70 }}
                />
              </Space>
            }
          >
            <div className="progress-card">
              <div
                className="progress-item"
                onClick={() =>
                  navigate("/tickets", {
                    state: { submittedFrom: undefined },
                  })
                }
              >
                <Typography.Text type="secondary">梳理完成</Typography.Text>
                <div className="progress-value">{stats.progress.triageCount}</div>
              </div>
              <div className="progress-item">
                <Typography.Text type="secondary">总体完成</Typography.Text>
                <div className="progress-value">{stats.progress.completeCount}</div>
              </div>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
