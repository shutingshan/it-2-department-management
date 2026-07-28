import { useState } from "react";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Avatar, Breadcrumb, Button, Checkbox, Layout, Menu, Modal, Space, Typography } from "antd";
import {
  ApartmentOutlined,
  AppstoreOutlined,
  BarChartOutlined,
  ClusterOutlined,
  HistoryOutlined,
  HomeOutlined,
  LogoutOutlined,
  SettingOutlined,
  SwapOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { useAuthStore } from "../store/auth";
import { useViewTargetStore } from "../store/viewTarget";
import UpdateTicketsButton from "../components/UpdateTicketsButton";
import MessageBell from "../components/MessageBell";
import { ROLE_LABELS } from "../api/types";
import { api } from "../api/client";
import "./AppShell.css";

const { Sider, Header, Content } = Layout;

const BASE_MENU_ITEMS = [
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
  // 侧边栏默认收起，把横向空间尽量留给工单列表（列很多，需要横向滚动）
  const [collapsed, setCollapsed] = useState(true);

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // "账号配置"/"变更日志"/"部门配置"仅管理员可见
  const MENU_ITEMS =
    user.role === "admin"
      ? [
          ...BASE_MENU_ITEMS,
          { key: "/dept-config", icon: <ApartmentOutlined />, label: "部门配置" },
          { key: "/account-config", icon: <SettingOutlined />, label: "账号配置" },
          { key: "/change-logs", icon: <HistoryOutlined />, label: "变更日志" },
        ]
      : BASE_MENU_ITEMS;

  function handleLogout() {
    Modal.confirm({
      title: "确认退出当前系统？",
      okText: "确认",
      cancelText: "取消",
      centered: true,
      onOk: () => {
        logout();
        navigate("/login");
      },
    });
  }

  const activeMenu = MENU_ITEMS.find((m) => location.pathname.startsWith(m.key));
  const activeKey = activeMenu?.key ?? "/tickets";
  const activeLabel = activeMenu?.label ?? "工单中心";

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider
        theme="light"
        width={188}
        collapsedWidth={64}
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        className="app-sider"
      >
        <div className="app-logo">
          <span className="app-logo-badge">IT</span>
          {!collapsed && <span className="app-logo-text">二部工单中心</span>}
        </div>
        <Menu
          theme="light"
          mode="inline"
          selectedKeys={[activeKey]}
          items={MENU_ITEMS}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header className="app-header">
          <div className="app-header-left">
            <Breadcrumb
              items={[{ title: "IT二部工单中心" }, { title: activeLabel }]}
            />
          </div>
          <Space size={12} className="app-header-right">
            <MyTicketsButton />
            <SwitchTargetButton />
            <UpdateTicketsButton onRefresh={() => setRefreshTick((t) => t + 1)} />
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

function MyTicketsButton() {
  const { user } = useAuthStore();
  const { setTargets } = useViewTargetStore();
  const navigate = useNavigate();
  if (!user) return null;

  // 快捷入口：把人员筛选直接设成自己，再跳到工单中心
  return (
    <Button
      icon={<UserOutlined />}
      onClick={() => {
        setTargets([user.name]);
        navigate("/tickets");
      }}
    >
      我负责的工单
    </Button>
  );
}

function SwitchTargetButton() {
  const { targets, setTargets } = useViewTargetStore();
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<any[]>([]);
  // 弹窗里先勾选、点确定才生效，避免每勾一个就刷一次列表
  const [draft, setDraft] = useState<string[]>([]);

  // 取真实工单数据里出现过的 IT 受理人（后端已去重排序），而不是预置的部门人员目录——
  // 目录里有的人可能一条工单都没有，工单里的受理人也可能不在目录里
  async function loadUsers() {
    const res = await api.get("/tickets/it-handlers");
    setUsers(res.data.data);
  }

  function toggle(name: string) {
    setDraft((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  }

  const currentLabel =
    targets.length === 0 ? "所有工单" : targets.length === 1 ? targets[0] : `${targets[0]} 等${targets.length}人`;

  return (
    <>
      <Button
        icon={<SwapOutlined />}
        onClick={() => {
          setDraft(targets);
          setOpen(true);
        }}
      >
        切换人员（{currentLabel}）
      </Button>
      <Modal
        title="切换查看对象（可多选）"
        open={open}
        onCancel={() => setOpen(false)}
        afterOpenChange={(visible) => visible && loadUsers()}
        okText="确定"
        cancelText="取消"
        onOk={() => {
          setTargets(draft);
          setOpen(false);
        }}
      >
        <div className="switch-user-list">
          <div
            className={"switch-user-item" + (draft.length === 0 ? " active" : "")}
            onClick={() => setDraft([])}
          >
            <span>所有工单（不限人员）</span>
          </div>
          {users.map((u) => (
            <div
              key={u.id}
              className={"switch-user-item" + (draft.includes(u.name) ? " active" : "")}
              onClick={() => toggle(u.name)}
            >
              <Checkbox checked={draft.includes(u.name)} onClick={(e) => e.preventDefault()} />
              <Avatar size="small" style={{ backgroundColor: u.avatarColor }}>
                {u.name.slice(-1)}
              </Avatar>
              <span>{u.name}</span>
            </div>
          ))}
        </div>
      </Modal>
    </>
  );
}

function UserMenu() {
  const { user } = useAuthStore();
  if (!user) return null;

  return (
    <Space size={6}>
      <Avatar size="small" style={{ backgroundColor: user.avatarColor }}>
        {user.name.slice(-1)}
      </Avatar>
      <Typography.Text>{user.name}</Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {ROLE_LABELS[user.role]}
      </Typography.Text>
    </Space>
  );
}
