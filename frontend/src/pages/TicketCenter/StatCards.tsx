import { useEffect, useState } from "react";
import { Tooltip } from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import { api } from "../../api/client";
import "./StatCards.css";

export interface CardStat {
  id: string;
  parentId: string | null;
  label: string;
  description: string | null;
  red: boolean;
  count: number;
}

export default function StatCards({
  activeCardKey,
  refreshKey,
  onSelect,
}: {
  activeCardKey?: string;
  refreshKey: number;
  onSelect: (cardKey: string) => void;
}) {
  const [stats, setStats] = useState<CardStat[]>([]);

  useEffect(() => {
    api.get("/tickets/card-stats").then((res) => setStats(res.data.data));
  }, [refreshKey]);

  const topLevel = stats.filter((s) => !s.parentId);
  const childrenOf = (id: string) => stats.filter((s) => s.parentId === id);

  return (
    <div className="stat-cards-row">
      {topLevel.map((card) => {
        const children = childrenOf(card.id);
        return (
          <div
            key={card.id}
            className={"stat-card" + (activeCardKey === card.id ? " active" : "")}
            onClick={() => onSelect(card.id)}
          >
            <div className="stat-card-head">
              <span className="stat-card-label">{card.label}</span>
              {card.description && (
                <Tooltip title={card.description}>
                  <QuestionCircleOutlined className="stat-card-help" />
                </Tooltip>
              )}
            </div>
            <div className={"stat-card-count" + (card.red ? " red" : "")}>{card.count}</div>
            {children.length > 0 && (
              <div className="stat-card-children">
                {children.map((c) => (
                  <div
                    key={c.id}
                    className={"stat-card-child" + (activeCardKey === c.id ? " active" : "")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(c.id);
                    }}
                  >
                    <span className="stat-card-child-label">
                      {c.label}
                      {c.description && (
                        <Tooltip title={c.description}>
                          <QuestionCircleOutlined className="stat-card-help" />
                        </Tooltip>
                      )}
                    </span>
                    <span className={"stat-card-child-count" + (c.red ? " red" : "")}>{c.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
