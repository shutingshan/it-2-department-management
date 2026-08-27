import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Form,
  InputNumber,
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
  monthlyPlan:
    "候选值取自现有工单的月度计划字段，跟排期口径保持一致；缺点是系统里还没排到的月份选不到。",
  generated:
    "以当前月份为基准前后各生成若干个月，不依赖现有工单数据，需方可以填还没有任何工单排到的月份。",
  custom: "只允许选下面这份手工维护的清单，适合按年度排期固定口径。",
};

/**
 * 「需方期望月度」下拉候选值的取值来源。
 *
 * 单独成一个区块而不是并进上面那个通用循环：那些配置一条记录就是一个字符串（{id,value}），
 * 这里是一组开关 + 数值 + 清单的整体配置，形状对不上。
 */
export default function ExpectedMonthSection() {
  const { user } = useAuthStore();
  const [form, setForm] = useState<ExpectedMonthSource | null>(null);
  const [options, setOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/expected-month-source");
      setForm(res.data.data);
      setOptions(res.data.options ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function set<K extends keyof ExpectedMonthSource>(key: K, value: ExpectedMonthSource[K]) {
    setForm((s) => (s ? { ...s, [key]: value } : s));
  }

  async function handleSave() {
    if (!form || !user) return;
    if (form.mode === "custom" && form.customMonths.length === 0) {
      message.error("取值来源为自定义清单时，至少需要配置一个月份");
      return;
    }
    setSaving(true);
    try {
      const res = await api.put("/expected-month-source", { ...form, actor: user.name });
      setForm(res.data.data);
      setOptions(res.data.options ?? []);
      message.success("已保存");
    } catch (e: any) {
      message.error(e?.response?.data?.message ?? "保存失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  if (!form) return null;

  return (
    <div className="scope-config-section">
      <div className="scope-config-section-header">
        <Typography.Text strong>需方期望月度取值来源</Typography.Text>
        <Button size="small" type="primary" loading={saving} onClick={handleSave}>
          保存
        </Button>
      </div>
      <Alert
        className="scope-config-hint"
        type="info"
        showIcon
        message="工单中心「需方期望月度」那一列的下拉候选值按这里配置的来源解析。这一项跟其余范围配置不同：它不筛选工单，只决定需方能选到哪些月份。"
      />

      <Form layout="vertical" disabled={loading}>
        <Form.Item label="取值来源">
          <Radio.Group
            value={form.mode}
            onChange={(e) => set("mode", e.target.value)}
            optionType="button"
            options={(Object.keys(EXPECTED_MONTH_MODE_LABELS) as ExpectedMonthSourceMode[]).map(
              (m) => ({ value: m, label: EXPECTED_MONTH_MODE_LABELS[m] })
            )}
          />
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            {MODE_HINTS[form.mode]}
          </Typography.Paragraph>
        </Form.Item>

        {form.mode === "monthlyPlan" && (
          <Form.Item label="并入子需求的月度计划">
            <Switch checked={form.includeSubTickets} onChange={(v) => set("includeSubTickets", v)} />
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
              tokenSeparators={[",", "，", " "]}
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
          extra="关闭后，来源收窄前已填写、且不在新候选值里的月份将无法再被选回"
        >
          <Switch
            checked={form.includeExistingValues}
            onChange={(v) => set("includeExistingValues", v)}
          />
        </Form.Item>
      </Form>

      <Alert
        type={options.length ? "info" : "warning"}
        showIcon
        message={`当前生效的候选值（${options.length} 个）`}
        description={
          options.length ? (
            <div style={{ maxHeight: 140, overflowY: "auto" }}>
              {options.map((m) => (
                <Tag key={m} style={{ marginBottom: 4 }}>
                  {m}
                </Tag>
              ))}
            </div>
          ) : (
            "暂无候选值，需方将无法选择期望月度。请检查上面的配置。"
          )
        }
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
        以上为已保存配置的解析结果，改完点「保存」后刷新。
      </Typography.Paragraph>
    </div>
  );
}
