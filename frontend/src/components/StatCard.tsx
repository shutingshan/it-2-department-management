import { Card, Statistic } from "antd";

export default function StatCard({
  title,
  value,
  suffix,
  color,
}: {
  title: string;
  value: number | string;
  suffix?: string;
  color?: string;
}) {
  return (
    <Card size="small" style={{ minWidth: 160 }}>
      <Statistic title={title} value={value} suffix={suffix} valueStyle={color ? { color } : undefined} />
    </Card>
  );
}
