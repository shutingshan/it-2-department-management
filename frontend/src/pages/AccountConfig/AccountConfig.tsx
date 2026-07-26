import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Button, Form, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message } from "antd";
import { LockOutlined, PlusOutlined } from "@ant-design/icons";
import { api } from "../../api/client";
import type { Account, AccountRole, User } from "../../api/types";
import { ROLE_LABELS } from "../../api/types";
import { useAuthStore } from "../../store/auth";
import "./AccountConfig.css";

const ACCOUNT_ROLES: AccountRole[] = ["admin", "it_handler", "requester"];

export default function AccountConfig() {
  const { user } = useAuthStore();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [directory, setDirectory] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<{ userId: string; role: AccountRole }>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [accountsRes, directoryRes] = await Promise.all([
        api.get("/accounts"),
        api.get("/accounts/directory"),
      ]);
      setAccounts(accountsRes.data.data);
      setDirectory(directoryRes.data.data);
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

  function openEdit(account: Account) {
    setEditing(account);
    form.setFieldsValue({ userId: account.userId, role: account.role });
    setModalOpen(true);
  }

  async function handleSubmit() {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      if (editing) {
        await api.patch(`/accounts/${editing.id}`, values);
        message.success("账号已更新");
      } else {
        await api.post("/accounts", values);
        message.success("账号已新增");
      }
      setModalOpen(false);
      load();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "提交失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(account: Account) {
    try {
      await api.delete(`/accounts/${account.id}`);
      message.success("账号已删除");
      load();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "删除失败，请稍后重试");
    }
  }

  // 可选姓名 = 未配置账号的人员 + 当前正在编辑的账号本人（否则编辑时选不回自己）
  const nameOptions = [
    ...directory,
    ...(editing && !directory.some((u) => u.id === editing.userId)
      ? [{ id: editing.userId, name: editing.name, pinyin: editing.pinyin } as User]
      : []),
  ].map((u) => ({ value: u.id, label: `${u.name}（${u.pinyin}）` }));

  if (user?.role !== "admin") {
    return <Navigate to="/tickets" replace />;
  }

  return (
    <div className="account-config-page">
      <div className="account-config-header">
        <Typography.Title level={4} style={{ margin: 0 }}>
          账号配置
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>
          新增账号
        </Button>
      </div>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={accounts}
        pagination={false}
        columns={[
          {
            title: "姓名",
            dataIndex: "name",
            render: (name: string, r: Account) => (
              <Space>
                {name}
                {r.locked && <LockOutlined style={{ color: "#8c8c8c" }} />}
              </Space>
            ),
          },
          { title: "拼音码", dataIndex: "pinyin" },
          {
            title: "角色",
            dataIndex: "role",
            render: (role: AccountRole, r: Account) => (
              <Tag color={role === "admin" ? "red" : role === "it_handler" ? "blue" : "default"}>
                {r.locked ? "超级管理员" : ROLE_LABELS[role]}
              </Tag>
            ),
          },
          {
            title: "操作",
            key: "actions",
            width: 140,
            render: (_: unknown, r: Account) =>
              r.locked ? (
                <Typography.Text type="secondary">系统默认，不可编辑</Typography.Text>
              ) : (
                <Space>
                  <Button type="link" size="small" onClick={() => openEdit(r)}>
                    编辑
                  </Button>
                  <Popconfirm title="确认删除该账号？" onConfirm={() => handleDelete(r)}>
                    <Button type="link" size="small" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
          },
        ]}
      />

      <Modal
        open={modalOpen}
        title={editing ? "编辑账号" : "新增账号"}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={submitting}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="role" label="角色" rules={[{ required: true, message: "请选择角色" }]}>
            <Select
              options={ACCOUNT_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
              placeholder="请选择角色"
            />
          </Form.Item>
          <Form.Item name="userId" label="姓名" rules={[{ required: true, message: "请选择姓名" }]}>
            <Select
              showSearch
              options={nameOptions}
              placeholder="请选择姓名"
              filterOption={(input, option) =>
                (option?.label as string)?.toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
