import express from "express";
import cors from "cors";
import morgan from "morgan";
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

app.listen(PORT, () => {
  console.log(`IT 二部工单中心系统 后端已启动: http://localhost:${PORT}`);
});
