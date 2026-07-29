import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { Button, Form, Input, Modal, Popconfirm, Select, Space, Tree, Typography, message } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import type { DataNode } from "antd/es/tree";
import { api } from "../../api/client";
import { useAuthStore } from "../../store/auth";
import "./DeptConfig.css";

interface FlatDept {
  id: string;
  name: string;
  parentId: string | null;
}

interface FormValues {
  name: string;
  parentId?: string;
}

export default function DeptConfig() {
  const { user } = useAuthStore();
  const [flat, setFlat] = useState<FlatDept[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<FlatDept | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<FormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/dept-config/flat");
      setFlat(res.data.data);
      setExpandedKeys(res.data.data.map((d: FlatDept) => d.id));
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

  function openEdit(dept: FlatDept) {
    setEditing(dept);
    form.setFieldsValue({
      name: dept.name,
      parentId: dept.parentId ?? undefined,
    });
    setModalOpen(true);
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    const payload = { name: values.name, parentId: values.parentId ?? null };
    setSubmitting(true);
    try {
      if (editing) {
        await api.patch(`/dept-config/${editing.id}`, payload);
        message.success("部门已更新");
      } else {
        await api.post("/dept-config", payload);
        message.success("部门已新增");
      }
      setModalOpen(false);
      load();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "提交失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(dept: FlatDept) {
    try {
      await api.delete(`/dept-config/${dept.id}`);
      message.success("部门已删除");
      load();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "删除失败，请稍后重试");
    }
  }

  // 上级部门候选：排除自己（编辑时）及自己的所有后代，避免循环引用
  const descendantIds = useMemo(() => {
    if (!editing) return new Set<string>();
    const ids = new Set<string>();
    const collect = (id: string) => {
      flat.filter((d) => d.parentId === id).forEach((c) => {
        ids.add(c.id);
        collect(c.id);
      });
    };
    collect(editing.id);
    return ids;
  }, [editing, flat]);

  const parentOptions = flat
    .filter((d) => d.id !== editing?.id && !descendantIds.has(d.id))
    .map((d) => ({ value: d.id, label: d.name }));

  const treeData: DataNode[] = useMemo(() => {
    function build(parentId: string | null): DataNode[] {
      return flat
        .filter((d) => d.parentId === parentId)
        .map((d) => ({
          key: d.id,
          title: (
            <Space>
              <span>{d.name}</span>
              <Button type="link" size="small" onClick={() => openEdit(d)}>
                编辑
              </Button>
              <Popconfirm title="确认删除该部门？" onConfirm={() => handleDelete(d)}>
                <Button type="link" size="small" danger>
                  删除
                </Button>
              </Popconfirm>
            </Space>
          ),
          children: build(d.id),
        }));
    }
    return build(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat]);

  if (user?.role !== "admin") {
    return <Navigate to="/tickets" replace />;
  }

  return (
    <div className="dept-config-page">
      <div className="dept-config-header">
        <Typography.Title level={4} style={{ margin: 0 }}>
          部门配置
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>
          新增部门
        </Button>
      </div>

      {!loading && flat.length === 0 && <Typography.Text type="secondary">暂无部门数据</Typography.Text>}
      <Tree
        treeData={treeData}
        expandedKeys={expandedKeys}
        onExpand={(keys) => setExpandedKeys(keys as string[])}
        selectable={false}
      />

      <Modal
        open={modalOpen}
        title={editing ? "编辑部门" : "新增部门"}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={submitting}
        destroyOnHidden
        width={520}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="部门名称" rules={[{ required: true, message: "请输入部门名称" }]}>
            <Input placeholder="请输入部门名称" />
          </Form.Item>
          <Form.Item name="parentId" label="上级部门">
            <Select allowClear options={parentOptions} placeholder="不选则为顶级部门" showSearch filterOption={(input, option) =>
                (option?.label as string)?.toLowerCase().includes(input.toLowerCase())
              } />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
