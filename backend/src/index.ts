import express from "express";
import cors from "cors";
import morgan from "morgan";
import path from "path";
import fs from "fs";
import os from "os";
import authRouter from "./routes/auth";
import accountsRouter from "./routes/accounts";
import ticketsRouter from "./routes/tickets";
import syncRouter from "./routes/sync";
import statsRouter from "./routes/stats";
import messagesRouter from "./routes/messages";
import departmentsRouter from "./routes/departments";
import deptConfigRouter from "./routes/deptConfig";
import scopeConfigRouter from "./routes/scopeConfig";
import defectTreeRouter from "./routes/defectTree";
import expectedMonthSourceRouter from "./routes/expectedMonthSource";
import logsRouter from "./routes/logs";
import changeLogsRouter from "./routes/changeLogs";
import exportRouter from "./routes/export";
import webhooksRouter from "./routes/webhooks";
import { runScheduledSyncChain, startScheduler } from "./scheduler";
import { store } from "./store";

const app = express();

// Express 5 默认的 query parser 是 "simple"，不会把 `a[]=1&a[]=2` 解析成数组，
// 而是原样留下 `a[]` 这个键——前端 axios 传数组时正是这种带方括号的格式，
// 会导致所有多选筛选项（工单阶段/状态/发起人/IT受理人等）全部静默失效。
// 换回 "extended"（qs）后，`a[]=1&a[]=2` 与 `a=1&a=2` 两种写法都能正确解析成数组
app.set("query parser", "extended");
const PORT = process.env.PORT ?? 4000;

// exposedHeaders：默认情况下浏览器读不到自定义响应头，
// 「导入匹配状态」要靠它把匹配/未匹配条数回显到页面上
app.use(cors({ exposedHeaders: ["Content-Disposition", "X-Match-Total", "X-Match-Matched", "X-Match-Unmatched"] }));
app.use(morgan("dev"));
app.use(express.json());

app.use("/api/auth", authRouter);
app.use("/api/accounts", accountsRouter);
app.use("/api/tickets", ticketsRouter);
app.use("/api/sync", syncRouter);
app.use("/api/stats", statsRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/departments", departmentsRouter);
app.use("/api/dept-config", deptConfigRouter);
app.use("/api/scope-config", scopeConfigRouter);
app.use("/api/defect-tree", defectTreeRouter);
app.use("/api/expected-month-source", expectedMonthSourceRouter);
app.use("/api/logs", logsRouter);
app.use("/api/change-logs", changeLogsRouter);
app.use("/api/export", exportRouter);
// 供 TAPD 反向调用（需要配置 TAPD_WEBHOOK_TOKEN 才会启用）
app.use("/api/webhooks", webhooksRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// 手动触发一次"每日定时同步"链路（获取新工单->更新工单->获取TAPD信息），用于运维排查/联调验证；
// 不等待链路执行完成，进度可通过 /api/sync/status 与"变更日志-数据同步"查看
app.post("/api/sync/trigger-scheduled", (_req, res) => {
  runScheduledSyncChain().catch((e) => console.error("手动触发定时同步任务异常:", e));
  res.json({ started: true });
});

// 生产环境下：把前端 `npm run build` 产物一并托管，避免额外部署 Nginx
const frontendDist = path.join(__dirname, "../../frontend/dist");
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

// 显式监听 0.0.0.0：让前端开发服务器（Vite）能跨机器代理到这个后端接口
app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`IT 二部工单中心系统 后端已启动: http://localhost:${PORT}`);
  const lanUrls = getLanUrls(Number(PORT));
  if (lanUrls.length > 0) {
    // 注意：这里只是后端 API 地址，不能直接发给同事打开——
    // 开发模式下登录页面由前端 Vite（5173 端口）提供，同事应访问前端打印出的 Network 地址
    console.log(`后端局域网地址（仅供调试 /api 接口，不要发给同事）: ${lanUrls.join(", ")}`);
  }
});

function getLanUrls(port: number): string[] {
  const nets = os.networkInterfaces();
  const urls: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    }
  }
  return urls;
}

startScheduler();

// 工单/站内信/日志现在是真实数据，不能只留在内存里：定时落盘，
// 并在进程正常退出（含 ts-node-dev 检测到文件变化触发的重启）前再落盘一次，尽量减少数据丢失窗口
const autosaveTimer = setInterval(() => store.save(), 5000);
function saveAndExit() {
  clearInterval(autosaveTimer);
  store.save();
  process.exit(0);
}
process.on("SIGINT", saveAndExit);
process.on("SIGTERM", saveAndExit);
