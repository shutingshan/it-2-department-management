import { useEffect, useState } from "react";
import { Badge, Button, Dropdown, Empty, List, Tabs, message as antdMessage } from "antd";
import { BellOutlined } from "@ant-design/icons";
import { api } from "../api/client";
import type { InSiteMessage } from "../api/types";
import { useAuthStore } from "../store/auth";

export default function MessageBell() {
  const { user } = useAuthStore();
  const [messages, setMessages] = useState<InSiteMessage[]>([]);
  const [tab, setTab] = useState<"unread" | "all">("unread");
  const [open, setOpen] = useState(false);

  async function load() {
    if (!user) return;
    const res = await api.get("/messages", { params: { actor: user.name, actorRole: user.role } });
    setMessages(res.data.data);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const unread = messages.filter((m) => !m.read);
  const list = tab === "unread" ? unread : messages;
  const isAdmin = user?.role === "admin";

  async function markRead(id: string) {
    if (!user) return;
    if (isAdmin) {
      antdMessage.warning("管理员可查看全部站内信，但不能代替他人标记为已读");
      return;
    }
    await api.patch(`/messages/${id}/read`, { actor: user.name, actorRole: user.role });
    load();
  }

  const content = (
    <div style={{ width: 340, background: "#fff", borderRadius: 8, boxShadow: "0 6px 24px rgba(0,0,0,0.12)" }}>
      <Tabs
        activeKey={tab}
        onChange={(k) => setTab(k as any)}
        style={{ padding: "8px 16px 0" }}
        items={[
          { key: "unread", label: `未读 (${unread.length})` },
          { key: "all", label: "全部" },
        ]}
      />
      <div style={{ maxHeight: 360, overflow: "auto", padding: "0 8px 8px" }}>
        {list.length === 0 ? (
          <Empty description="暂无消息" style={{ padding: 24 }} />
        ) : (
          <List
            dataSource={list}
            renderItem={(m) => (
              <List.Item
                style={{
                  cursor: isAdmin ? "not-allowed" : "pointer",
                  opacity: m.read ? 0.55 : 1,
                  padding: "10px 8px",
                }}
                onClick={() => markRead(m.id)}
              >
                <div style={{ width: "100%" }}>
                  <div style={{ fontSize: 13 }}>
                    <b>{m.requesterName}</b> {m.action}
                  </div>
                  <div style={{ fontSize: 12, color: "#8c8c8c", marginTop: 2 }}>
                    工单编号：{m.ticketCode} · IT受理人：{m.itHandler} · {m.time}
                  </div>
                </div>
              </List.Item>
            )}
          />
        )}
      </div>
    </div>
  );

  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      popupRender={() => content}
      trigger={["click"]}
      placement="bottomRight"
    >
      <Button type="text" icon={<Badge count={unread.length} size="small"><BellOutlined style={{ fontSize: 18 }} /></Badge>} />
    </Dropdown>
  );
}
