import { useEffect, useState } from "react";
import {
  Button,
  Descriptions,
  Drawer,
  Input,
  Space,
  Switch,
  Table,
  Tag,
  Timeline,
  Typography,
  message,
} from "antd";
import { CopyOutlined, LinkOutlined } from "@ant-design/icons";
import { api } from "../../api/client";
import { hoursDeviation, STAGE_COLORS } from "../../api/types";
import type { Ticket } from "../../api/types";
import { useAuthStore } from "../../store/auth";

export default function DetailDrawer({
  ticketId,
  open,
  onClose,
  onSaved,
}: {
  ticketId: string | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { user } = useAuthStore();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [edited, setEdited] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [subTab, setSubTab] = useState<"detail" | "history">("detail");

  useEffect(() => {
    if (open && ticketId) {
      api.get(`/tickets/${ticketId}`).then((res) => {
        setTicket(res.data.data);
        setEdited({});
        setSubTab("detail");
      });
    }
  }, [open, ticketId]);

  const canEditAll = user?.role === "admin" || user?.role === "it_handler";
  const canEditUrgent = user?.role === "requester" || canEditAll;

  async function handleSubmit() {
    if (!ticket || !user) return;
    if (Object.keys(edited).length === 0) {
      message.info("没有需要提交的修改");
      return;
    }
    setSaving(true);
    try {
      const res = await api.patch(`/tickets/${ticket.id}`, {
        fields: edited,
        actor: user.name,
        actorRole: user.role,
      });
      setTicket(res.data.data);
      setEdited({});
      message.success("提交成功");
      onSaved();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "提交失败，请检查权限或字段校验");
    } finally {
      setSaving(false);
    }
  }

  if (!ticket) {
    return <Drawer open={open} onClose={onClose} width={640} title="工单详情" destroyOnHidden />;
  }

  const deviation = hoursDeviation(ticket);
  const deviationClass = deviation >= 5 ? "dev-red" : deviation > 0 ? "dev-yellow" : "";

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={720}
      destroyOnHidden
      title={
        <Space>
          <span>{ticket.code}</span>
          <Button
            size="small"
            type="text"
            icon={<CopyOutlined />}
            onClick={() => {
              navigator.clipboard.writeText(ticket.code);
              message.success("已复制编号");
            }}
          />
          <Tag color={STAGE_COLORS[ticket.stage]}>{ticket.stage}</Tag>
          {ticket.urgent && <Tag color="red">紧急</Tag>}
        </Space>
      }
      extra={
        <Space>
          <Button onClick={() => setSubTab(subTab === "detail" ? "history" : "detail")}>
            {subTab === "detail" ? "查看变更记录" : "返回详情"}
          </Button>
          <Button type="primary" loading={saving} onClick={handleSubmit}>
            提交
          </Button>
        </Space>
      }
    >
      {subTab === "detail" ? (
        <>
          <Descriptions column={2} size="small" bordered>
            <Descriptions.Item label="标题" span={2}>
              {ticket.title}
            </Descriptions.Item>
            <Descriptions.Item label="内容" span={2}>
              {ticket.content}
            </Descriptions.Item>
            <Descriptions.Item label="分类">
              {canEditAll ? (
                <Input
                  size="small"
                  defaultValue={ticket.category}
                  onChange={(e) => setEdited((s) => ({ ...s, category: e.target.value }))}
                />
              ) : (
                ticket.category
              )}
            </Descriptions.Item>
            <Descriptions.Item label="归属应用">{ticket.owningApp}</Descriptions.Item>
            <Descriptions.Item label="模块">
              {canEditAll ? (
                <Input
                  size="small"
                  defaultValue={ticket.module}
                  onChange={(e) => setEdited((s) => ({ ...s, module: e.target.value }))}
                />
              ) : (
                ticket.module
              )}
            </Descriptions.Item>
            <Descriptions.Item label="TAPD 地址">
              {ticket.tapdUrl ? (
                <a href={ticket.tapdUrl} target="_blank" rel="noreferrer">
                  <LinkOutlined /> 查看 TAPD
                </a>
              ) : (
                <Typography.Text type="secondary">无</Typography.Text>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="发起人">{ticket.requester}</Descriptions.Item>
            <Descriptions.Item label="发起部门">{ticket.requesterDept}</Descriptions.Item>
            <Descriptions.Item label="当前处理人">{ticket.currentHandler}</Descriptions.Item>
            <Descriptions.Item label="IT 受理人">
              {canEditAll ? (
                <Input
                  size="small"
                  defaultValue={ticket.itHandler}
                  onChange={(e) => setEdited((s) => ({ ...s, itHandler: e.target.value }))}
                />
              ) : (
                ticket.itHandler
              )}
            </Descriptions.Item>
            <Descriptions.Item label="开发人员">{ticket.developer.join("、") || "-"}</Descriptions.Item>
            <Descriptions.Item label="状态">{ticket.status}</Descriptions.Item>
            <Descriptions.Item label="紧急">
              {canEditUrgent ? (
                <Switch
                  defaultChecked={ticket.urgent}
                  onChange={(checked) => setEdited((s) => ({ ...s, urgent: checked }))}
                />
              ) : ticket.urgent ? (
                "是"
              ) : (
                "否"
              )}
            </Descriptions.Item>
            <Descriptions.Item label="优先级">{ticket.priority ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="月度计划">{ticket.monthlyPlan.join("、") || "-"}</Descriptions.Item>
            <Descriptions.Item label="迭代">
              {ticket.iterations.map((i) => i.name).join("、") || "-"}
            </Descriptions.Item>
            <Descriptions.Item label="预计梳理完成时间">{ticket.expectedTriageTime ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="实际梳理完成时间">{ticket.actualTriageTime ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="预计完成时间">{ticket.expectedCompleteTime ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="实际完成时间">{ticket.actualCompleteTime ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="预估工时">{ticket.estimatedHours}</Descriptions.Item>
            <Descriptions.Item label="实际工时">{ticket.actualHours}</Descriptions.Item>
            <Descriptions.Item label="工时偏差">
              <span className={deviationClass}>{deviation}</span>
            </Descriptions.Item>
            <Descriptions.Item label="提交时间">{ticket.submittedAt}</Descriptions.Item>
          </Descriptions>

          {ticket.subTickets.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <Typography.Title level={5}>子需求（{ticket.subTickets.length}）</Typography.Title>
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={ticket.subTickets}
                columns={[
                  { title: "编号", dataIndex: "code" },
                  { title: "标题", dataIndex: "title", ellipsis: true },
                  { title: "开发人员", dataIndex: "developer" },
                  { title: "当前处理人", dataIndex: "currentHandler" },
                  { title: "迭代", dataIndex: ["iteration", "name"] },
                  { title: "预估工时", dataIndex: "estimatedHours" },
                  { title: "实际工时", dataIndex: "actualHours" },
                ]}
              />
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <Typography.Title level={5}>处理记录</Typography.Title>
            <Timeline
              items={ticket.processingNotes
                .slice()
                .reverse()
                .map((n) => ({
                  children: (
                    <div>
                      <div>{n.content}</div>
                      <div style={{ fontSize: 12, color: "#8c8c8c" }}>
                        {n.actor} · {n.time}
                      </div>
                    </div>
                  ),
                }))}
            />
          </div>
        </>
      ) : (
        <Table
          size="small"
          rowKey={(r) => `${r.field}-${r.time}`}
          pagination={false}
          dataSource={ticket.changeHistory}
          columns={[
            { title: "字段", dataIndex: "field" },
            { title: "原值", dataIndex: "oldValue" },
            { title: "新值", dataIndex: "newValue" },
            { title: "操作人", dataIndex: "actor" },
            { title: "时间", dataIndex: "time" },
          ]}
        />
      )}
    </Drawer>
  );
}
