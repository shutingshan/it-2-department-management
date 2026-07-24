import { useState } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Avatar, Button, Layout, Menu, Modal, Space, Typography } from "antd";
import {
  AppstoreOutlined,
  BarChartOutlined,
  ClusterOutlined,
  HomeOutlined,
  LogoutOutlined,
  SwapOutlined,
} from "@ant-design/icons";
import { useAuthStore } from "../store/auth";
import SyncButton from "../components/SyncButton";
import MessageBell from "../components/MessageBell";
import { ROLE_LABELS } from "../api/types";
import { api } from "../api/client";
import "./AppShell.css";

const { Sider, Header, Content } = Layout;

const MENU_ITEMS = [
  { key: "/home", icon: <HomeOutlined />, label: "首页" },
  { key: "/tickets", icon: <AppstoreOutlined />, label: "工单中心" },
  { key: "/dev-hours", icon: <BarChartOutlined />, label: "开发工时统计" },
  { key: "/departments", icon: <ClusterOutlined />, label: "部门统计" },
];

export default function AppShell() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [refreshTick, setRefreshTick] = useState(0);

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  function handleLogout() {
    Modal.confirm({
      title: "确认退出系统？",
      okText: "确认",
      cancelText: "取消",
      onOk: () => {
        logout();
        navigate("/login");
      },
    });
  }

  const activeKey =
    MENU_ITEMS.find((m) => location.pathname.startsWith(m.key))?.key ?? "/tickets";

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider theme="dark" width={188} className="app-sider">
        <div className="app-logo">
          <span className="app-logo-badge">IT</span>
          <span className="app-logo-text">二部工单中心</span>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[activeKey]}
          items={MENU_ITEMS}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header className="app-header">
          <div className="app-header-left" />
          <Space size={12} className="app-header-right">
            <SyncButton onRefresh={() => setRefreshTick((t) => t + 1)} />
            <MessageBell />
            <UserMenu />
            <Button type="text" icon={<LogoutOutlined />} onClick={handleLogout}>
              退出
            </Button>
          </Space>
        </Header>
        <Content className="app-content">
          <Outlet context={{ refreshTick }} />
        </Content>
      </Layout>
    </Layout>
  );
}

function UserMenu() {
  const { user } = useAuthStore();
  const [switching, setSwitching] = useState(false);
  if (!user) return null;

  const isAdmin = user.role === "admin";

  return (
    <>
      <Space size={6}>
        <Avatar size="small" style={{ backgroundColor: user.avatarColor }}>
          {user.name.slice(-1)}
        </Avatar>
        <Typography.Text>{user.name}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {ROLE_LABELS[user.role]}
        </Typography.Text>
        {isAdmin && (
          <Button size="small" type="link" icon={<SwapOutlined />} onClick={() => setSwitching(true)}>
            切换人员
          </Button>
        )}
      </Space>
      <SwitchUserModal open={switching} onClose={() => setSwitching(false)} />
    </>
  );
}

function SwitchUserModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { setUser } = useAuthStore();
  const [users, setUsers] = useState<any[]>([]);

  async function loadUsers() {
    const res = await api.get("/auth/users");
    setUsers(res.data.data);
  }

  return (
    <Modal
      title="切换人员（管理员专属）"
      open={open}
      onCancel={onClose}
      afterOpenChange={(visible) => visible && loadUsers()}
      footer={null}
    >
      <div className="switch-user-list">
        {users.map((u) => (
          <div
            key={u.id}
            className="switch-user-item"
            onClick={() => {
              setUser(u);
              onClose();
            }}
          >
            <Avatar size="small" style={{ backgroundColor: u.avatarColor }}>
              {u.name.slice(-1)}
            </Avatar>
            <span>{u.name}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {ROLE_LABELS[u.role as keyof typeof ROLE_LABELS]}
            </Typography.Text>
          </div>
        ))}
      </div>
    </Modal>
  );
}
