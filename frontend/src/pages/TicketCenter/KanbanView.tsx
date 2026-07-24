import { Card, Empty, Tag, Typography } from "antd";
import { STAGE_COLORS } from "../../api/types";
import type { Ticket, TicketStage } from "../../api/types";

const STAGES: TicketStage[] = ["待排期", "方案梳理", "开发中", "测试验收中", "已完成", "关闭"];

export default function KanbanView({
  tickets,
  onOpen,
}: {
  tickets: Ticket[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="kanban-board">
      {STAGES.map((stage) => {
        const list = tickets.filter((t) => t.stage === stage);
        return (
          <div className="kanban-col" key={stage}>
            <div className="kanban-col-header">
              <Tag color={STAGE_COLORS[stage]}>{stage}</Tag>
              <span className="kanban-count">{list.length}</span>
            </div>
            <div className="kanban-col-body">
              {list.length === 0 && <Empty description={false} style={{ marginTop: 24 }} />}
              {list.map((t) => (
                <Card
                  key={t.id}
                  size="small"
                  className="kanban-card"
                  onClick={() => onOpen(t.id)}
                  hoverable
                >
                  <div className="ellipsis kanban-card-title">{t.title}</div>
                  <div className="kanban-card-meta">
                    <span>{t.code}</span>
                    {t.urgent && <Tag color="red">紧急</Tag>}
                  </div>
                  <div className="kanban-card-meta">
                    <Typography.Text type="secondary">{t.requester}</Typography.Text>
                    <Typography.Text type="secondary">{t.itHandler}</Typography.Text>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
