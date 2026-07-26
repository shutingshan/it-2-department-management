import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(__dirname, "../.env") });

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `缺少环境变量 ${name}，请在 backend/.env 中配置（参考 backend/.env.example，该文件不会被提交到 git）`
    );
  }
  return v;
}

export const config = {
  dangquyun: {
    get username() {
      return required("DANGQUYUN_USERNAME");
    },
    get password() {
      return required("DANGQUYUN_PASSWORD");
    },
    get targetUrl() {
      return required("DANGQUYUN_TARGET_URL");
    },
    get loginUrl() {
      return process.env.DANGQUYUN_LOGIN_URL || "";
    },
    get debug() {
      return process.env.DANGQUYUN_DEBUG === "true";
    },
    // 复用本机已安装的 Chrome，省去单独下载 Playwright 自带 Chromium 的步骤；
    // 服务器上如果没有装 Chrome，把 .env 里 DANGQUYUN_BROWSER_CHANNEL 留空即可回退到 Playwright 自带内核
    get browserChannel(): "chrome" | undefined {
      const v = process.env.DANGQUYUN_BROWSER_CHANNEL;
      if (v === undefined) return "chrome";
      return v === "" ? undefined : (v as "chrome");
    },
  },
  tapd: {
    // TAPD 用扫码登录，没有账号密码；登录态通过 backend/.auth/tapd-state.json 复用
    get baseUrl() {
      return process.env.TAPD_BASE_URL || "https://www.tapd.cn/";
    },
    // 调试模式：保存失败截图/HTML 到 backend/.auth/debug/
    get debug() {
      return process.env.TAPD_DEBUG === "true";
    },
    get browserChannel(): "chrome" | undefined {
      const v = process.env.TAPD_BROWSER_CHANNEL;
      if (v === undefined) return "chrome";
      return v === "" ? undefined : (v as "chrome");
    },
  },
};
