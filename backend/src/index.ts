import express from "express";
import cors from "cors";
import morgan from "morgan";
import path from "path";
import fs from "fs";
import authRouter from "./routes/auth";
import accountsRouter from "./routes/accounts";
import ticketsRouter from "./routes/tickets";
import syncRouter from "./routes/sync";
import statsRouter from "./routes/stats";
import messagesRouter from "./routes/messages";
import departmentsRouter from "./routes/departments";
import deptConfigRouter from "./routes/deptConfig";
import logsRouter from "./routes/logs";
import changeLogsRouter from "./routes/changeLogs";
import exportRouter from "./routes/export";
import { runScheduledSyncChain, startScheduler } from "./scheduler";
import { store } from "./store";

const app = express();
const PORT = process.env.PORT ?? 4000;

app.use(cors());
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
app.use("/api/logs", logsRouter);
app.use("/api/change-logs", changeLogsRouter);
app.use("/api/export", exportRouter);

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

app.listen(PORT, () => {
  console.log(`IT 二部工单中心系统 后端已启动: http://localhost:${PORT}`);
});

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
