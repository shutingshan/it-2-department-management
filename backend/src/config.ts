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
    // ---- 开放平台 API（现用方案）----
    // API账号/口令跟登录TAPD用的账号密码不是一回事，需要公司管理员在 TAPD 后台单独开通
    get apiBaseUrl() {
      return process.env.TAPD_API_BASE_URL || "https://api.tapd.cn";
    },
    get apiUser() {
      return required("TAPD_API_USER");
    },
    get apiPassword() {
      return required("TAPD_API_PASSWORD");
    },
    // ---- 以下为浏览器自动化方案遗留配置（已不用于取数，保留仅为兼容）----
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
