import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Alert, AutoComplete, Button, Form, Modal, Popconfirm, Space, Table, Typography, message } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { api } from "../../api/client";
import type { ScopeConfigItem, ScopeKind } from "../../api/types";
import { useAuthStore } from "../../store/auth";
import "./ScopeConfig.css";

interface SectionMeta {
  kind: ScopeKind;
  title: string;
  /** 这一类范围到底影响什么，直接写在页面上，避免以后没人说得清 */
  description: string;
  addLabel: string;
  valueLabel: string;
  emptyHint: string;
}

const SECTIONS: SectionMeta[] = [
  {
    kind: "handlers",
    title: "获取工单受理人范围",
    description:
      "「获取新工单」「全量获取」时，只把受理人命中下表的工单导入工单中心；一条工单有多个受理人时，命中其中任意一人即导入。",
    addLabel: "新增受理人",
    valueLabel: "受理人",
    emptyHint: "当前未配置，表示不按受理人限制，抓到的工单会全部导入。",
  },
  {
    kind: "categories",
    title: "工单中心显示分类",
    description:
      "工单中心只显示分类命中下表的工单；统计卡片数量与导出同样按这个范围计算，三者口径一致。",
    addLabel: "新增分类",
    valueLabel: "工单分类",
    emptyHint: "当前未配置，表示不按分类限制，工单中心显示全部分类。",
  },
];

export default function ScopeConfig() {
  const { user } = useAuthStore();
  const [data, setData] = useState<Record<ScopeKind, ScopeConfigItem[]>>({
    handlers: [],
    categories: [],
  });
  const [options, setOptions] = useState<Record<ScopeKind, string[]>>({
    handlers: [],
    categories: [],
  });
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState<{ section: SectionMeta; editing: ScopeConfigItem | null } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<{ value: string }>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [configRes, optionsRes] = await Promise.all([
        api.get("/scope-config"),
        api.get("/scope-config/options"),
      ]);
      setData(configRes.data.data);
      setOptions(optionsRes.data.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openAdd(section: SectionMeta) {
    form.resetFields();
    setModal({ section, editing: null });
  }

  function openEdit(section: SectionMeta, item: ScopeConfigItem) {
    form.setFieldsValue({ value: item.value });
    setModal({ section, editing: item });
  }

  async function handleSubmit() {
    if (!modal) return;
    const { value } = await form.validateFields();
    const { kind } = modal.section;
    setSubmitting(true);
    try {
      if (modal.editing) {
        await api.patch(`/scope-config/${kind}/${modal.editing.id}`, { value });
        message.success("已更新");
      } else {
        await api.post(`/scope-config/${kind}`, { value });
        message.success("已新增");
      }
      setModal(null);
      load();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "提交失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(kind: ScopeKind, item: ScopeConfigItem) {
    try {
      await api.delete(`/scope-config/${kind}/${item.id}`);
      message.success("已删除");
      load();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "删除失败，请稍后重试");
    }
  }

  if (user?.role !== "admin") {
    return <Navigate to="/tickets" replace />;
  }

  return (
    <div className="scope-config-page">
      <div className="scope-config-header">
        <Typography.Title level={4} style={{ margin: 0 }}>
          取数与显示范围配置
        </Typography.Title>
      </div>

      {SECTIONS.map((section) => {
        const list = data[section.kind];
        return (
          <div className="scope-config-section" key={section.kind}>
            <div className="scope-config-section-header">
              <Typography.Text strong>{section.title}</Typography.Text>
              <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openAdd(section)}>
                {section.addLabel}
              </Button>
            </div>
            <Alert
              className="scope-config-hint"
              type={list.length ? "info" : "warning"}
              showIcon
              message={list.length ? section.description : `${section.emptyHint} ${section.description}`}
            />
            <Table
              rowKey="id"
              size="small"
              loading={loading}
              dataSource={list}
              pagination={false}
              locale={{ emptyText: "未配置" }}
              columns={[
                { title: section.valueLabel, dataIndex: "value" },
                {
                  title: "操作",
                  width: 140,
                  render: (_: unknown, item: ScopeConfigItem) => (
                    <Space size={8}>
                      <a onClick={() => openEdit(section, item)}>编辑</a>
                      <Popconfirm
                        title={`确认删除「${item.value}」？`}
                        okText="确认删除"
                        okButtonProps={{ danger: true }}
                        cancelText="取消"
                        onConfirm={() => handleDelete(section.kind, item)}
                      >
                        <a style={{ color: "#ff4d4f" }}>删除</a>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
          </div>
        );
      })}

      <Modal
        title={`${modal?.editing ? "编辑" : "新增"}${modal?.section.valueLabel ?? ""}`}
        open={!!modal}
        onCancel={() => setModal(null)}
        onOk={handleSubmit}
        confirmLoading={submitting}
        okText="确定"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="value"
            label={modal?.section.valueLabel}
            rules={[{ required: true, message: `请输入${modal?.section.valueLabel ?? "内容"}` }]}
          >
            {/* 候选取自已有工单数据；AutoComplete 本身就允许输入候选之外的值，
                用于新同事/新分类还没有任何工单的情况 */}
            <AutoComplete
              allowClear
              placeholder="可从已有工单中选择，也可直接输入"
              filterOption={(input, option) => String(option?.value ?? "").includes(input)}
              options={(modal ? options[modal.section.kind] : []).map((v) => ({ value: v }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
