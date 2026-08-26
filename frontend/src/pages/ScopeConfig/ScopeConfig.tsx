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
  /**
   * 未配置时的提示色。保留语义（只显示配置里的）未配置意味着"没生效"，用黄色提醒；
   * 排除语义（不显示配置里的）未配置就是正常默认状态，用黄色反而像出了问题
   */
  emptyTone?: "warning" | "info";
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
  {
    kind: "defectCategories",
    title: "缺陷跟进显示分类",
    description:
      "缺陷跟进页只显示分类命中下表的工单。这一项跟上面的「工单中心显示分类」相互独立：工单中心通常只留「需求」，缺陷跟进要看的正是被它挡掉的分类，所以两边各配各的。归属应用与状态的排除名单两个页面共用。",
    addLabel: "新增分类",
    valueLabel: "工单分类",
    emptyHint: "当前未配置，表示不按分类限制，缺陷跟进页会显示全部分类的工单。",
  },
  {
    kind: "excludedApps",
    title: "工单中心排除的归属应用",
    description:
      "与上面两项相反，这里配的是「不看什么」：归属应用命中下表的工单不在工单中心显示，统计卡片与导出同样不计入。与分类范围同时配置时取交集——先按分类范围保留，再从中去掉这些归属应用。",
    addLabel: "新增归属应用",
    valueLabel: "归属应用",
    emptyHint: "当前未配置，表示不排除任何归属应用。",
    emptyTone: "info",
  },
  {
    kind: "excludedStatuses",
    title: "工单中心排除的状态",
    description:
      "状态命中下表的工单不在工单中心显示，统计卡片与导出同样不计入。常用于把「关闭」「已完成」这类不需要日常盯的状态收起来。与其余范围配置同时生效时取交集。",
    addLabel: "新增状态",
    valueLabel: "状态",
    emptyHint: "当前未配置，表示不排除任何状态。",
    emptyTone: "info",
  },
  {
    kind: "verifyCodes",
    title: "抓取结果校验工单编号",
    description:
      "「获取新工单」抓完后，会检查这些编号是否都出现在抓到的当曲云列表里；只要有一条对不上，就判定这次抓的不是目标列表，整份结果作废、不写入任何数据。请选长期稳定留在当曲云列表里的已完成工单。",
    addLabel: "新增校验编号",
    valueLabel: "工单编号",
    emptyHint: "当前未配置，将自动取显示范围内最近完成的一条工单来校验。",
    emptyTone: "info",
  },
];

export default function ScopeConfig() {
  const { user } = useAuthStore();
  const [data, setData] = useState<Record<ScopeKind, ScopeConfigItem[]>>({
    handlers: [],
    categories: [],
    defectCategories: [],
    excludedApps: [],
    excludedStatuses: [],
    verifyCodes: [],
  });
  const [options, setOptions] = useState<Record<ScopeKind, string[]>>({
    handlers: [],
    categories: [],
    defectCategories: [],
    excludedApps: [],
    excludedStatuses: [],
    verifyCodes: [],
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
              type={list.length ? "info" : section.emptyTone ?? "warning"}
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
