import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Table, Tabs, Tag, Typography } from "antd";
import { api } from "../../api/client";
import { useAuthStore } from "../../store/auth";
import "./ChangeLogs.css";

interface DataChangeRow {
  id: string;
  actor: string;
  changeType: string;
  detail: string;
  time: string;
}

interface SyncLogRow {
  id: string;
  buttonName: string;
  trigger: string;
  changeType: string;
  detail: string;
  time: string;
}

export default function ChangeLogs() {
  const { user } = useAuthStore();
  const [dataChanges, setDataChanges] = useState<DataChangeRow[]>([]);
  const [syncLogs, setSyncLogs] = useState<SyncLogRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([api.get("/change-logs/data-changes"), api.get("/change-logs/sync-logs")])
      .then(([a, b]) => {
        setDataChanges(a.data.data);
        setSyncLogs(b.data.data);
      })
      .finally(() => setLoading(false));
  }, []);

  if (user?.role !== "admin") {
    return <Navigate to="/tickets" replace />;
  }

  return (
    <div className="change-logs-page">
      <Typography.Title level={4} style={{ margin: 0 }}>
        变更日志
      </Typography.Title>
      <Tabs
        defaultActiveKey="data-changes"
        items={[
          {
            key: "data-changes",
            label: "数据变更",
            children: (
              <Table
                rowKey="id"
                loading={loading}
                dataSource={dataChanges}
                columns={[
                  { title: "操作人", dataIndex: "actor", width: 120 },
                  {
                    title: "变更类型",
                    dataIndex: "changeType",
                    width: 120,
                    render: (v: string) => <Tag>{v}</Tag>,
                  },
                  { title: "日志详情", dataIndex: "detail" },
                  { title: "操作时间", dataIndex: "time", width: 180 },
                ]}
              />
            ),
          },
          {
            key: "sync-logs",
            label: "数据同步",
            children: (
              <Table
                rowKey="id"
                loading={loading}
                dataSource={syncLogs}
                columns={[
                  { title: "按钮名称", dataIndex: "buttonName", width: 120 },
                  { title: "触发点", dataIndex: "trigger", width: 120 },
                  {
                    title: "变更类型",
                    dataIndex: "changeType",
                    width: 100,
                    render: (v: string) => <Tag color={v === "成功" ? "green" : "red"}>{v}</Tag>,
                  },
                  { title: "日志详情", dataIndex: "detail" },
                  { title: "操作时间", dataIndex: "time", width: 180 },
                ]}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
