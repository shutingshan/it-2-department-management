import type { ReactNode } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useThemeStore } from "./store/theme";

// antd 组件的配色由这里统一切换：深色时套用官方的 darkAlgorithm，
// 自定义 CSS 那部分则通过 html[data-theme] + CSS 变量切换（见 store/theme.ts 与 index.css）
export default function ThemeProvider({ children }: { children: ReactNode }) {
  const mode = useThemeStore((s) => s.mode);
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: mode === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          // 深色下主色调亮一点，否则跟深背景对比度不够、按钮和链接会显得发闷
          colorPrimary: mode === "dark" ? "#597ef7" : "#2f54eb",
          borderRadius: 6,
          fontSize: 13,
        },
      }}
    >
      {children}
    </ConfigProvider>
  );
}
