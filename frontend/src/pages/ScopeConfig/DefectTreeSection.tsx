import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { api } from "../../api/client";
import type { DefectTreeNode } from "../../api/types";

/**
 * 缺陷跟进左侧应用树的分组配置。
 *
 * 跟同页面上面那几项范围配置不是一个数据形状（那些是单值 {id,value}，这里一条记录
 * 是「显示名称 + 一组归属应用」），所以单独成一个区块，而不是硬塞进那个通用循环里。
 */
export default function DefectTreeSection() {
  const [nodes, setNodes] = useState<DefectTreeNode[]>([]);
  const [appOptions, setAppOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<DefectTreeNode | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<{ name: string; apps?: string[] }>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [listRes, optionsRes] = await Promise.all([
        api.get("/defect-tree"),
        api.get("/defect-tree/options"),
      ]);
      setNodes(listRes.data.data);
      setAppOptions(optionsRes.data.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openAdd() {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  }

  function openEdit(node: DefectTreeNode) {
    setEditing(node);
    form.setFieldsValue({ name: node.name, apps: node.apps });
    setModalOpen(true);
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      if (editing) {
        await api.patch(`/defect-tree/${editing.id}`, { name: values.name, apps: values.apps ?? [] });
        message.success("已更新");
      } else {
        await api.post("/defect-tree", { name: values.name, apps: values.apps ?? [] });
        message.success("已新增");
      }
      setModalOpen(false);
      load();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "提交失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(node: DefectTreeNode) {
    try {
      await api.delete(`/defect-tree/${node.id}`);
      message.success("已删除");
      load();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "删除失败，请稍后重试");
    }
  }

  return (
    <div className="scope-config-section">
      <div className="scope-config-section-header">
        <Typography.Text strong>缺陷跟进树形分组</Typography.Text>
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openAdd}>
          新增节点
        </Button>
      </div>
      <Alert
        className="scope-config-hint"
        type={nodes.length ? "info" : "info"}
        showIcon
        message={
          nodes.length
            ? "缺陷跟进页左侧的树按下表渲染：一个节点一行，点击后右侧只显示该节点包含的归属应用。根节点「全部」始终存在，展示不分应用的全部缺陷。没有被任何节点包含的归属应用会按原样各挂一个节点排在分组后面，不会漏掉。"
            : "当前未配置，缺陷跟进页左侧的树按原始形态展示：每个归属应用各占一个节点。配置后改为按下表的分组展示。"
        }
      />
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={nodes}
        pagination={false}
        locale={{ emptyText: "未配置" }}
        columns={[
          { title: "节点显示名称", dataIndex: "name", width: 200 },
          {
            title: "包含的归属应用",
            dataIndex: "apps",
            render: (apps: string[]) =>
              apps.length ? (
                <Space size={[4, 4]} wrap>
                  {apps.map((a) => (
                    <Tag key={a}>{a}</Tag>
                  ))}
                </Space>
              ) : (
                <Typography.Text type="secondary">未包含任何应用（该节点点开是空的）</Typography.Text>
              ),
          },
          {
            title: "操作",
            width: 140,
            render: (_: unknown, node: DefectTreeNode) => (
              <Space size={8}>
                <a onClick={() => openEdit(node)}>编辑</a>
                <Popconfirm
                  title={`确认删除节点「${node.name}」？`}
                  okText="确认删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() => handleDelete(node)}
                >
                  <a style={{ color: "#ff4d4f" }}>删除</a>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={`${editing ? "编辑" : "新增"}树形节点`}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={submitting}
        okText="确定"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="节点显示名称" rules={[{ required: true, message: "请输入节点显示名称" }]}>
            <Input placeholder="如：供应链、财务" />
          </Form.Item>
          <Form.Item
            name="apps"
            label="包含的归属应用"
            extra="候选取自缺陷范围内已有的归属应用；也可直接输入尚未出现过的应用名"
          >
            {/* tags 模式：允许输入候选之外的值，用于新应用还没有任何缺陷的情况 */}
            <Select
              mode="tags"
              allowClear
              placeholder="可多选"
              options={appOptions.map((v) => ({ value: v, label: v }))}
              tokenSeparators={["、", ",", "，"]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
