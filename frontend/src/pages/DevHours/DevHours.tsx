import { useEffect, useMemo, useRef, useState } from "react";
import { Card, Col, Row, Select, Table, Radio } from "antd";
import ReactECharts from "echarts-for-react";
import { api } from "../../api/client";

// 迭代筛选的"全部迭代"选项，跟真实迭代名称不会撞车
const ALL_ITERATIONS_KEY = "__all__";

export default function DevHours() {
  const [data, setData] = useState<any>(null);
  // 支持多选 + "全部迭代"：数组里出现 ALL_ITERATIONS_KEY 就代表不按迭代过滤
  const [iterations, setIterations] = useState<string[]>([]);
  const [year, setYear] = useState(2026);
  const [devFilter, setDevFilter] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<"diffHours" | "completedCount">("diffHours");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const initializedRef = useRef(false);

  const isAll = iterations.length === 0 || iterations.includes(ALL_ITERATIONS_KEY);

  useEffect(() => {
    api
      .get("/stats/dev-hours", { params: { iterations: isAll ? undefined : iterations, year } })
      .then((res) => {
        setData(res.data);
        // 首次进入页面默认选中"当前迭代"（单选），之后用户自己选就不再干预
        if (!initializedRef.current) {
          initializedRef.current = true;
          if (res.data.currentIteration) setIterations([res.data.currentIteration]);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iterations.join(","), year]);

  // "全部迭代"跟具体迭代互斥：选中"全部迭代"就清空其余选择；
  // 已经是"全部迭代"时再多选具体迭代，则去掉"全部迭代"这个标记
  function handleIterationsChange(vals: string[]) {
    const hadAll = iterations.includes(ALL_ITERATIONS_KEY);
    const hasAll = vals.includes(ALL_ITERATIONS_KEY);
    if (vals.length === 0) {
      setIterations([ALL_ITERATIONS_KEY]);
    } else if (hasAll && !hadAll) {
      setIterations([ALL_ITERATIONS_KEY]);
    } else if (hasAll && hadAll && vals.length > 1) {
      setIterations(vals.filter((v) => v !== ALL_ITERATIONS_KEY));
    } else {
      setIterations(vals);
    }
  }

  const yoyOption = useMemo(() => {
    if (!data) return {};
    return {
      tooltip: { trigger: "axis" },
      legend: { data: ["预估工时", "实际工时"] },
      xAxis: { type: "category", data: data.yoyTrend.map((y: any) => y.year) },
      yAxis: { type: "value" },
      series: [
        {
          name: "预估工时",
          type: "line",
          data: data.yoyTrend.map((y: any) => y.estimatedHours),
          label: { show: true, position: "top" },
        },
        {
          name: "实际工时",
          type: "line",
          data: data.yoyTrend.map((y: any) => y.actualHours),
          label: { show: true, position: "top" },
        },
      ],
    };
  }, [data]);

  const annualSorted = useMemo(() => {
    if (!data) return [];
    const arr = [...data.annualSummary];
    arr.sort((a: any, b: any) => (sortOrder === "asc" ? a[sortKey] - b[sortKey] : b[sortKey] - a[sortKey]));
    return arr;
  }, [data, sortKey, sortOrder]);

  const filteredIterationTickets = useMemo(() => {
    if (!data) return [];
    if (!devFilter) return data.iterationTickets;
    // 一行可能对应多个开发人员（顿号拼接），按人名精确匹配，不能整串比较
    return data.iterationTickets.filter((t: any) =>
      t.developer
        .split(/[、,，]/)
        .map((s: string) => s.trim())
        .includes(devFilter)
    );
  }, [data, devFilter]);

  const deptHoursOption = useMemo(() => {
    if (!data) return {};
    return {
      tooltip: { trigger: "axis" },
      legend: { data: ["已花费实际工时", "预估待花费工时"] },
      xAxis: { type: "category", data: data.deptHours.map((d: any) => d.deptName) },
      yAxis: { type: "value" },
      series: [
        { name: "已花费实际工时", type: "bar", data: data.deptHours.map((d: any) => d.spentHours) },
        { name: "预估待花费工时", type: "bar", data: data.deptHours.map((d: any) => d.estimatedSpentHours) },
      ],
    };
  }, [data]);

  if (!data) return null;

  return (
    <div>
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={16}>
          <Card
            size="small"
            title="开发人员迭代工时汇总"
            extra={
              <Select
                size="small"
                mode="multiple"
                value={isAll ? [ALL_ITERATIONS_KEY] : iterations}
                onChange={handleIterationsChange}
                style={{ minWidth: 200 }}
                maxTagCount={1}
                options={[
                  { value: ALL_ITERATIONS_KEY, label: "全部迭代" },
                  ...data.iterations.map((it: any) => ({ value: it.name, label: it.name })),
                ]}
              />
            }
          >
            <Table
              size="small"
              rowKey="developer"
              pagination={false}
              dataSource={data.iterationSummary}
              columns={[
                { title: "开发人员", dataIndex: "developer" },
                {
                  title: "工单数",
                  dataIndex: "ticketCount",
                  render: (v: number, r: any) => <a onClick={() => setDevFilter(r.developer)}>{v}</a>,
                },
                { title: "预估工时", dataIndex: "estimatedHours" },
                { title: "实际工时", dataIndex: "actualHours" },
                {
                  title: "工时偏差",
                  dataIndex: "diffHours",
                  sorter: (a: any, b: any) => a.diffHours - b.diffHours,
                },
              ]}
            />
            {devFilter && (
              <div style={{ marginTop: 8 }}>
                <a onClick={() => setDevFilter(null)}>清除筛选（保留迭代条件）</a>
              </div>
            )}
          </Card>

          <Card size="small" title="迭代工单列表" style={{ marginTop: 12 }}>
            <Table
              size="small"
              rowKey="code"
              dataSource={filteredIterationTickets}
              pagination={{ pageSize: 8 }}
              columns={[
                {
                  title: "工时偏差",
                  dataIndex: "hoursDeviation",
                  render: (v: number) => (
                    <span className={v >= 5 ? "dev-red" : v > 0 ? "dev-yellow" : ""}>{v}</span>
                  ),
                },
                { title: "编号", dataIndex: "code" },
                {
                  title: "TAPD地址",
                  dataIndex: "tapdUrl",
                  render: (u: string | null) =>
                    u ? (
                      <a href={u} target="_blank" rel="noreferrer">
                        查看
                      </a>
                    ) : (
                      "-"
                    ),
                },
                { title: "归属应用", dataIndex: "owningApp" },
                { title: "发起人", dataIndex: "requester" },
                { title: "标题", dataIndex: "title", ellipsis: true },
                { title: "内容", dataIndex: "content", ellipsis: true },
                { title: "开发人员", dataIndex: "developer", width: 100, ellipsis: true },
                { title: "迭代", dataIndex: "iteration" },
                { title: "预估工时", dataIndex: "estimatedHours" },
                { title: "实际工时", dataIndex: "actualHours" },
              ]}
            />
          </Card>
        </Col>

        <Col span={8}>
          <Card
            size="small"
            title="年度完成同比趋势"
            extra={
              <Select
                size="small"
                value={year}
                onChange={setYear}
                style={{ width: 90 }}
                options={[2024, 2025, 2026].map((y) => ({ value: y, label: y }))}
              />
            }
          >
            <ReactECharts option={yoyOption} style={{ height: 220 }} />
          </Card>

          <Card
            size="small"
            title="开发人员年度完成差异"
            style={{ marginTop: 12 }}
            extra={
              <Radio.Group
                size="small"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
              >
                <Radio.Button value="desc">倒序</Radio.Button>
                <Radio.Button value="asc">顺序</Radio.Button>
              </Radio.Group>
            }
          >
            <Table
              size="small"
              rowKey="developer"
              pagination={false}
              dataSource={annualSorted}
              columns={[
                { title: "开发人员", dataIndex: "developer" },
                {
                  title: "完成数",
                  dataIndex: "completedCount",
                  onHeaderCell: () => ({ onClick: () => setSortKey("completedCount") }),
                },
                {
                  title: "工时偏差",
                  dataIndex: "diffHours",
                  onHeaderCell: () => ({ onClick: () => setSortKey("diffHours") }),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={12}>
        <Col span={24}>
          <Card
            size="small"
            title="各部门开发工时花费情况"
            extra={
              <Select
                size="small"
                value={year}
                onChange={setYear}
                style={{ width: 90 }}
                options={[2024, 2025, 2026].map((y) => ({ value: y, label: y }))}
              />
            }
          >
            <ReactECharts option={deptHoursOption} style={{ height: 260 }} />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
