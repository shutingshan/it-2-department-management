import dotenv from "dotenv";
import path from "path";
import { ExpectedMonthSource, ExpectedMonthSourceMode } from "./types";

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

function intFromEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v === "true";
}

export const config = {
  // 「需方期望月度」下拉取值来源的默认配置；运行期可通过 /api/settings 覆盖并落盘
  get expectedMonthSource(): ExpectedMonthSource {
    const mode = process.env.EXPECTED_MONTH_SOURCE_MODE as ExpectedMonthSourceMode | undefined;
    return {
      mode: mode === "generated" || mode === "custom" ? mode : "monthlyPlan",
      includeSubTickets: boolFromEnv("EXPECTED_MONTH_INCLUDE_SUB_TICKETS", true),
      pastMonths: intFromEnv("EXPECTED_MONTH_PAST_MONTHS", 3),
      futureMonths: intFromEnv("EXPECTED_MONTH_FUTURE_MONTHS", 12),
      customMonths: (process.env.EXPECTED_MONTH_CUSTOM_MONTHS ?? "")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
      includeExistingValues: boolFromEnv("EXPECTED_MONTH_INCLUDE_EXISTING", true),
    };
  },
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
};
