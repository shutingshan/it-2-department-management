import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Checkbox, Input, message } from "antd";
import { api } from "../api/client";
import { useAuthStore } from "../store/auth";
import "./Login.css";

export default function Login() {
  const navigate = useNavigate();
  const { setUser, rememberedAccount, setRememberedAccount } = useAuthStore();
  const [account, setAccount] = useState(rememberedAccount);
  const [remember, setRemember] = useState(!!rememberedAccount);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const isComposing = useRef(false);

  async function doLogin() {
    if (!account.trim()) {
      setErrorText("请输入账号");
      return;
    }
    setLoading(true);
    setErrorText(null);
    try {
      const res = await api.post("/auth/login", { account: account.trim() });
      setUser(res.data.user);
      setRememberedAccount(account.trim(), remember);
      message.success(`欢迎回来，${res.data.user.name}`);
      navigate("/tickets");
    } catch (e: any) {
      if (e?.response?.status === 404) {
        // 账号不存在：区分“账号不存在”与“系统加载失败”
        setErrorText(`账号不存在，如无权限请联系管理员「${e.response.data?.adminName ?? "管理员"}」`);
      } else {
        setErrorText("系统加载失败，请稍后重试");
      }
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // 回车仅在登录框内且不处于中文输入法组合态时可触发登录
    if (e.key === "Enter" && !isComposing.current) {
      doLogin();
    }
  }

  return (
    <div className="login-page">
      <div className="login-mask" aria-hidden />
      <div className="login-card">
        <div className="login-flower" aria-hidden>
          {/* 小红花图标占位，后续替换为正式素材 */}
          <span className="flower-emoji">🌺</span>
        </div>
        <h1 className="login-title">优秀的你，值得一朵小红花</h1>
        <p className="login-subtitle">IT 二部工单中心系统</p>

        <div className="login-form">
          <Input
            size="large"
            placeholder="请输入账号（姓名或拼音码）"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            onCompositionStart={() => (isComposing.current = true)}
            onCompositionEnd={() => (isComposing.current = false)}
            onKeyDown={onKeyDown}
            autoFocus
            allowClear
          />
          {errorText && <div className="login-error">{errorText}</div>}
          <div className="login-remember">
            <Checkbox
              checked={remember}
              onChange={(e) => {
                const checked = e.target.checked;
                setRemember(checked);
                // 取消勾选后立即清除本地记忆
                if (!checked) setRememberedAccount("", false);
              }}
            >
              记住账号
            </Checkbox>
          </div>
          <Button type="primary" size="large" block loading={loading} onClick={doLogin}>
            登录
          </Button>
        </div>
      </div>
    </div>
  );
}
