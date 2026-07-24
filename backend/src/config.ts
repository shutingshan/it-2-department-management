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
  },
};
