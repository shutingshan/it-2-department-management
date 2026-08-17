import express from "express";
import cors from "cors";
import morgan from "morgan";
import path from "path";
import fs from "fs";
import os from "os";
import authRouter from "./routes/auth";
import ticketsRouter from "./routes/tickets";
import syncRouter from "./routes/sync";
import statsRouter from "./routes/stats";
import messagesRouter from "./routes/messages";
import departmentsRouter from "./routes/departments";
import logsRouter from "./routes/logs";
import exportRouter from "./routes/export";

const app = express();
const PORT = process.env.PORT ?? 4000;

app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

app.use("/api/auth", authRouter);
app.use("/api/tickets", ticketsRouter);
app.use("/api/sync", syncRouter);
app.use("/api/stats", statsRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/departments", departmentsRouter);
app.use("/api/logs", logsRouter);
app.use("/api/export", exportRouter);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// 生产环境下：把前端 `npm run build` 产物一并托管，避免额外部署 Nginx
const frontendDist = path.join(__dirname, "../../frontend/dist");
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

// 显式监听 0.0.0.0：同事在同一局域网内可通过本机的局域网 IP 访问，无需额外部署
app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`IT 二部工单中心系统 后端已启动: http://localhost:${PORT}`);
  const lanUrls = getLanUrls(Number(PORT));
  if (lanUrls.length > 0) {
    console.log(`局域网访问地址（同事可用）: ${lanUrls.join(", ")}`);
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
