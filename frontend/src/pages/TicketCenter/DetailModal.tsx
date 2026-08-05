import { useEffect, useState } from "react";
import { Button, Descriptions, Input, Modal, Space, Table, Tag, Timeline, Typography, message } from "antd";
import { CopyOutlined, LinkOutlined } from "@ant-design/icons";
import { api } from "../../api/client";
import { formatIterations, hoursDeviation, STAGE_COLORS } from "../../api/types";
import type { Ticket } from "../../api/types";
import { useAuthStore } from "../../store/auth";
import { copyText } from "../../utils/clipboard";

export default function DetailModal({
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
  const [edited, setEdited] = useState<{ urgent?: string; remark?: string }>({});
  const [saving, setSaving] = useState(false);
  const [subTab, setSubTab] = useState<"detail" | "history">("detail");

  useEffect(() => {
    if (open && ticketId && user) {
      api
        .get(`/tickets/${ticketId}`, { params: { actor: user.name, actorRole: user.role } })
        .then((res) => {
          setTicket(res.data.data);
          setEdited({});
          setSubTab("detail");
        });
    }
  }, [open, ticketId, user]);

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
      onClose();
    } catch (e: any) {
      // 反馈失败原因：权限不足 / 字段校验失败 / 同步失败等，后端会给出具体文案
      message.error(e?.response?.data?.message ?? "提交失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  if (!ticket) {
    return <Modal open={open} onCancel={onClose} title="工单详情" footer={null} destroyOnHidden width={1100} />;
  }

  const deviation = hoursDeviation(ticket);
  const deviationClass = deviation >= 5 ? "dev-red" : deviation > 0 ? "dev-yellow" : "";
  // IT 受理人仅能编辑本人负责的工单；需求方可见的工单本身已限定为本人相关，管理员不受限
  const canEdit = !(user?.role === "it_handler" && ticket.itHandler !== user.name);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      destroyOnHidden
      width={1100}
      title={
        <Space>
          <span>{ticket.code}</span>
          <Button
            size="small"
            type="text"
            icon={<CopyOutlined />}
            onClick={async () => {
              const ok = await copyText(ticket.code);
              if (ok) message.success(`已复制编号 ${ticket.code}`);
              else message.error("复制失败，请手动选中编号复制");
            }}
          />
          <Tag color={STAGE_COLORS[ticket.stage]}>{ticket.stage}</Tag>
          {ticket.urgent.trim() && <Tag color="red">{ticket.urgent}</Tag>}
        </Space>
      }
      footer={
        <Space>
          <Button onClick={() => setSubTab(subTab === "detail" ? "history" : "detail")}>
            {subTab === "detail" ? "查看变更记录" : "返回详情"}
          </Button>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={handleSubmit}>
            提交
          </Button>
        </Space>
      }
    >
      {subTab === "detail" ? (
        <div style={{ maxHeight: "calc(100vh - 260px)", overflow: "auto" }}>
          <Descriptions column={4} size="small" bordered>
            <Descriptions.Item label="标题" span={4}>
              {ticket.title}
            </Descriptions.Item>
            <Descriptions.Item label="内容" span={4}>
              {ticket.content}
            </Descriptions.Item>
            <Descriptions.Item label="分类">{ticket.category}</Descriptions.Item>
            <Descriptions.Item label="归属应用">{ticket.owningApp}</Descriptions.Item>
            <Descriptions.Item label="模块">{ticket.module}</Descriptions.Item>
            <Descriptions.Item label="TAPD 地址">
              {ticket.tapdUrl ? (
                <a href={ticket.tapdUrl} target="_blank" rel="noreferrer">
                  <LinkOutlined /> 查看
                </a>
              ) : (
                <Typography.Text type="secondary">无</Typography.Text>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="发起人">{ticket.requester}</Descriptions.Item>
            <Descriptions.Item label="发起部门">{ticket.requesterDept}</Descriptions.Item>
            <Descriptions.Item label="当前处理人">{ticket.currentHandler}</Descriptions.Item>
            <Descriptions.Item label="IT 受理人">{ticket.itHandler}</Descriptions.Item>
            <Descriptions.Item label="开发人员">{ticket.developer.join("、") || "-"}</Descriptions.Item>
            <Descriptions.Item label="工单阶段">
              <Tag color={STAGE_COLORS[ticket.stage]}>{ticket.stage}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="状态">{ticket.status}</Descriptions.Item>
            <Descriptions.Item label="TAPD状态">{ticket.devStatus ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="紧急">
              <Input
                size="small"
                disabled={!canEdit}
                placeholder="填写紧急"
                value={edited.urgent ?? ticket.urgent}
                onChange={(e) => setEdited((s) => ({ ...s, urgent: e.target.value }))}
              />
            </Descriptions.Item>
            <Descriptions.Item label="优先级">{ticket.priority ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="月度计划">{ticket.monthlyPlan.join("、") || "-"}</Descriptions.Item>
            <Descriptions.Item label="迭代">{formatIterations(ticket.iterations)}</Descriptions.Item>
            <Descriptions.Item label="预计梳理完成时间">{ticket.expectedTriageTime ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="实际梳理完成时间">{ticket.actualTriageTime ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="预计完成时间">{ticket.expectedCompleteTime ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="实际完成时间">{ticket.actualCompleteTime ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="预估工时">{ticket.estimatedHours}</Descriptions.Item>
            <Descriptions.Item label="完成工时">{ticket.actualHours}</Descriptions.Item>
            <Descriptions.Item label="工时偏差">
              <span className={deviationClass}>{deviation}</span>
            </Descriptions.Item>
            <Descriptions.Item label="提交时间">{ticket.submittedAt}</Descriptions.Item>
            <Descriptions.Item label="备注" span={4}>
              <Input
                size="small"
                disabled={!canEdit}
                defaultValue={ticket.remark}
                placeholder="填写备注"
                onChange={(e) => setEdited((s) => ({ ...s, remark: e.target.value }))}
              />
            </Descriptions.Item>
            {ticket.tapdErrorNote && (
              <Descriptions.Item label="TAPD异常备注" span={4}>
                <Typography.Text type="danger">
                  {ticket.tapdErrorNote.time} {ticket.tapdErrorNote.message}
                </Typography.Text>
              </Descriptions.Item>
            )}
            {ticket.dangquyunErrorNote && (
              <Descriptions.Item label="同步当曲云异常" span={4}>
                <Typography.Text type="danger">
                  {ticket.dangquyunErrorNote.time} {ticket.dangquyunErrorNote.message}
                </Typography.Text>
              </Descriptions.Item>
            )}
          </Descriptions>

          {ticket.subTickets.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Typography.Title level={5}>子需求（{ticket.subTickets.length}）</Typography.Title>
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={ticket.subTickets}
                columns={[
                  { title: "标题", dataIndex: "title", ellipsis: true },
                  { title: "产品经理", dataIndex: "productManager", width: 90 },
                  { title: "开发人员", dataIndex: "developer", width: 90 },
                  { title: "测试人员", dataIndex: "tester", width: 90 },
                  { title: "处理人", dataIndex: "currentHandler", width: 90 },
                  { title: "TAPD状态", dataIndex: "tapdStatus", width: 90 },
                  { title: "预估工时", dataIndex: "estimatedHours", width: 80 },
                  { title: "完成工时", dataIndex: "actualHours", width: 80 },
                ]}
              />
            </div>
          )}

          <div style={{ marginTop: 12 }}>
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
        </div>
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
    </Modal>
  );
}
