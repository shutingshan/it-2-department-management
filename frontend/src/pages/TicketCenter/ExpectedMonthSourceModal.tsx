import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Form,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from "antd";
import { api } from "../../api/client";
import { EXPECTED_MONTH_MODE_LABELS } from "../../api/types";
import type { ExpectedMonthSource, ExpectedMonthSourceMode } from "../../api/types";
import { useAuthStore } from "../../store/auth";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const MODE_HINTS: Record<ExpectedMonthSourceMode, string> = {
  monthlyPlan: "候选值取自系统内工单已有的月度计划字段，随工单数据自动变化。",
  generated: "以当前月份为基准自动生成连续月份，不依赖已有工单数据，需方可以选到更远的月份。",
  custom: "只允许选择下面手工维护的月份清单，适合按年度排期固定口径。",
};

export default function ExpectedMonthSourceModal({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { user } = useAuthStore();
  const [form, setForm] = useState<ExpectedMonthSource | null>(null);
  const [preview, setPreview] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api
      .get("/settings/expected-month-source")
      .then((res) => {
        setForm(res.data.data);
        setPreview(res.data.options ?? []);
      })
      .finally(() => setLoading(false));
  }, [open]);

  function set<K extends keyof ExpectedMonthSource>(key: K, value: ExpectedMonthSource[K]) {
    setForm((s) => (s ? { ...s, [key]: value } : s));
  }

  async function handleSave() {
    if (!form || !user) return;
    if (form.mode === "custom" && form.customMonths.length === 0) {
      message.error("来源模式为自定义清单时，至少需要配置一个月份");
      return;
    }
    setSaving(true);
    try {
      const res = await api.put("/settings/expected-month-source", {
        ...form,
        actorRole: user.role,
      });
      setForm(res.data.data);
      setPreview(res.data.options ?? []);
      message.success("需方期望月度取值来源已更新");
      onSaved();
      onClose();
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "保存失败，请检查权限或配置项");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title="需方期望月度 · 取值来源配置"
      open={open}
      onCancel={onClose}
      width={620}
      footer={[
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button key="save" type="primary" loading={saving} disabled={!form} onClick={handleSave}>
          保存
        </Button>,
      ]}
    >
      {form && (
        <Form layout="vertical" disabled={loading}>
          <Form.Item label="取值来源">
            <Radio.Group
              value={form.mode}
              onChange={(e) => set("mode", e.target.value)}
              options={(Object.keys(EXPECTED_MONTH_MODE_LABELS) as ExpectedMonthSourceMode[]).map(
                (m) => ({ value: m, label: EXPECTED_MONTH_MODE_LABELS[m] })
              )}
              optionType="button"
            />
            <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              {MODE_HINTS[form.mode]}
            </Typography.Paragraph>
          </Form.Item>

          {form.mode === "monthlyPlan" && (
            <Form.Item label="包含子需求的月度计划">
              <Switch
                checked={form.includeSubTickets}
                onChange={(v) => set("includeSubTickets", v)}
              />
            </Form.Item>
          )}

          {form.mode === "generated" && (
            <Space size={24}>
              <Form.Item label="往前生成月份数">
                <InputNumber
                  min={0}
                  max={60}
                  value={form.pastMonths}
                  onChange={(v) => set("pastMonths", v ?? 0)}
                />
              </Form.Item>
              <Form.Item label="往后生成月份数">
                <InputNumber
                  min={0}
                  max={60}
                  value={form.futureMonths}
                  onChange={(v) => set("futureMonths", v ?? 0)}
                />
              </Form.Item>
            </Space>
          )}

          {form.mode === "custom" && (
            <Form.Item
              label="自定义月份清单"
              extra="输入 YYYY-MM 后回车添加，例如 2026-09"
              validateStatus={form.customMonths.length === 0 ? "error" : undefined}
            >
              <Select
                mode="tags"
                allowClear
                style={{ width: "100%" }}
                placeholder="输入月份后回车"
                value={form.customMonths}
                tokenSeparators={[",", " "]}
                onChange={(vals: string[]) => {
                  const invalid = vals.filter((v) => !MONTH_RE.test(v));
                  if (invalid.length) message.warning(`已忽略非法月份：${invalid.join("、")}`);
                  set("customMonths", Array.from(new Set(vals.filter((v) => MONTH_RE.test(v)))).sort());
                }}
              />
            </Form.Item>
          )}

          <Form.Item
            label="保留已填写的期望月度"
            extra="关闭后，来源收窄前已填写、且不在新候选值内的月份将无法再被选回"
          >
            <Switch
              checked={form.includeExistingValues}
              onChange={(v) => set("includeExistingValues", v)}
            />
          </Form.Item>

          <Alert
            type="info"
            showIcon
            message={`当前生效的候选值（${preview.length} 个）`}
            description={
              preview.length ? (
                <div style={{ maxHeight: 120, overflowY: "auto" }}>
                  {preview.map((m) => (
                    <Tag key={m} style={{ marginBottom: 4 }}>
                      {m}
                    </Tag>
                  ))}
                </div>
              ) : (
                "暂无候选值，需方将无法选择期望月度"
              )
            }
          />
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            上方为保存前的生效值，保存后按新配置重新解析。
          </Typography.Paragraph>
        </Form>
      )}
    </Modal>
  );
}
