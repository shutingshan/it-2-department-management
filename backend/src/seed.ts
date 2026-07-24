import { v4 as uuid } from "uuid";
import dayjs from "dayjs";
import {
  Department,
  InSiteMessage,
  IterationRef,
  LogEntry,
  Role,
  Ticket,
  TicketStatus,
  User,
} from "./types";
import { dedupe, resolveStage } from "./mapping";

// 固定种子的伪随机数生成器，保证每次启动生成的数据一致，便于演示与联调
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260724);
const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const pickMany = <T,>(arr: T[], n: number): T[] => {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  }
  return out;
};
const randInt = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;

export const DEPARTMENTS: Department[] = [
  { id: "dept-supply", name: "供应链中心", parentId: null },
  { id: "dept-purchase", name: "采购部", parentId: "dept-supply" },
  { id: "dept-warehouse", name: "仓储物流部", parentId: "dept-supply" },
  { id: "dept-brand", name: "品牌事业部", parentId: null },
  { id: "dept-brand-agent", name: "品牌代理组", parentId: "dept-brand" },
  { id: "dept-ecom", name: "电商运营组", parentId: "dept-brand" },
  { id: "dept-finance", name: "财务共享中心", parentId: null },
  { id: "dept-ap", name: "应付会计组", parentId: "dept-finance" },
  { id: "dept-it", name: "IT研发中心", parentId: null },
  { id: "dept-product", name: "产品组", parentId: "dept-it" },
  { id: "dept-qa", name: "测试组", parentId: "dept-it" },
];

interface SeedUser extends User {}

export const USERS: SeedUser[] = [
  { id: "u-admin", name: "系统管理员", pinyin: "xtgly", role: "admin", departmentId: "dept-it", avatarColor: "#2f54eb" },
  { id: "u-czm", name: "陈志明", pinyin: "czm", role: "it_handler", departmentId: "dept-it", avatarColor: "#13a8a8" },
  { id: "u-ljy", name: "林嘉怡", pinyin: "ljy", role: "it_handler", departmentId: "dept-it", avatarColor: "#722ed1" },
  { id: "u-hjj", name: "黄俊杰", pinyin: "hjj", role: "it_handler", departmentId: "dept-it", avatarColor: "#eb2f96" },
  { id: "u-wxd", name: "王晓东", pinyin: "wxd", role: "developer", departmentId: "dept-it", avatarColor: "#fa8c16" },
  { id: "u-lsy", name: "李思远", pinyin: "lsy", role: "developer", departmentId: "dept-it", avatarColor: "#52c41a" },
  { id: "u-zmq", name: "赵梦琪", pinyin: "zmq", role: "developer", departmentId: "dept-it", avatarColor: "#1677ff" },
  { id: "u-zzh", name: "周子豪", pinyin: "zzh", role: "developer", departmentId: "dept-it", avatarColor: "#f5222d" },
  { id: "u-ml", name: "马丽", pinyin: "ml", role: "tester", departmentId: "dept-qa", avatarColor: "#a0d911" },
  { id: "u-gy", name: "高远", pinyin: "gy", role: "pm", departmentId: "dept-product", avatarColor: "#faad14" },
  { id: "u-xmm", name: "谢敏敏", pinyin: "xmm", role: "requester", departmentId: "dept-purchase", avatarColor: "#597ef7" },
  { id: "u-zw", name: "张伟", pinyin: "zw", role: "requester", departmentId: "dept-warehouse", avatarColor: "#36cfc9" },
  { id: "u-lf", name: "刘芳", pinyin: "lf", role: "requester", departmentId: "dept-brand-agent", avatarColor: "#ff85c0" },
  { id: "u-cx", name: "陈晓", pinyin: "cx", role: "requester", departmentId: "dept-ecom", avatarColor: "#95de64" },
  { id: "u-sln", name: "孙丽娜", pinyin: "sln", role: "requester", departmentId: "dept-ap", avatarColor: "#ffc069" },
  { id: "u-wty", name: "吴天宇", pinyin: "wty", role: "requester", departmentId: "dept-purchase", avatarColor: "#69c0ff" },
  { id: "u-zjq", name: "郑佳琪", pinyin: "zjq", role: "requester", departmentId: "dept-brand-agent", avatarColor: "#b37feb" },
  { id: "u-hj", name: "何俊", pinyin: "hj", role: "requester", departmentId: "dept-warehouse", avatarColor: "#ff9c6e" },
];

const REQUESTERS = USERS.filter((u) => u.role === "requester");
const IT_HANDLERS = USERS.filter((u) => u.role === "it_handler");
const DEVELOPERS = USERS.filter((u) => u.role === "developer");

const OWNING_APPS = ["ERP-业务", "印务管理", "lumi网站", "品牌代理", "集采", "OA办公", "财务系统"];
const MODULES = ["-", "报关模块", "验货模块", "出运模块", "采购合同", "商品资料", "订单中心", "结算中心"];
const CATEGORIES = ["需求", "数据处理", "缺陷", "咨询"];

const TITLE_POOL = [
  "日本逆算货件触发上传税金单任务",
  "外单位拼箱的出运通知书增加提醒",
  "验货数据差异确认任务页面优化",
  "出运增加展讯装柜",
  "采购合同变更费用加减项，需发任务通知财务",
  "外销客户PI签订的我司抬头和我司收款抬头不一致",
  "试跑工厂待办提醒（已线下沟通通过）",
  "AI自动化策划组内部的机械化操作",
  "【香港办】——新增BI报表分析",
  "外销名片印刷流程优化",
  "工单拆分-每日导出各品类料号的采购计划",
  "【集采】包材统计降本",
  "仓库库存差异自动预警",
  "供应商结算周期调整",
  "订单拆分规则不满足香港仓需求",
  "商品资料同步延迟导致上架失败",
  "客户信用额度校验逻辑优化",
  "报表导出乱码问题修复",
  "移动端审批消息推送延迟",
  "部门权限矩阵调整需求",
];

const CONTENT_POOL = [
  "若日本的货件，申报方式为【第三方ACP逆算】，需要在货件到港后自动触发上传税金单任务，避免人工遗漏。",
  "需求：如有外单位拼箱的，需我司合作工厂帮忙对外发送出运通知书，目前流程中缺少自动提醒环节。",
  "需求：验货差异确认任务差异数据不明显，实际差异原因和处理建议展示不清晰，需要页面优化。",
  "需求：出运明细分箱数据这装柜在物流的，当下没有对应字段承接，需要增加。",
  "背景：YFK26003029 申请支付之后，业务端更改了合同费用条款，需要同步通知财务重新核算。",
  "背景：有一个客户78201，之前签的PI我司抬头和我司收款抬头不一致，导致对账困难。",
  "问题：两家试跑工厂端的“确认”、“确认印刷”处理流程已经线下沟通通过，需要系统同步调整。",
  "针对策划一组工作内容中较为机械化的操作，希望通过自动化脚本降低人工重复劳动。",
  "附件是香港办的销售分析表需求，请协助新增BI报表分析看板。",
  "公司外销团队名片操作流程比较花时间和偏机械化，希望能提供模板化生成工具。",
];

const DEV_STATUS_BY_STATUS: Record<string, string[]> = {
  已梳理: ["开发完成", "实现中", "转测试", "测试中", "待验收", "已验收", "规划中"],
};

function randomPinyinTitle() {
  return pick(TITLE_POOL);
}
function randomContent() {
  return pick(CONTENT_POOL);
}

function makeIteration(afterDate: dayjs.Dayjs, idx: number): IterationRef {
  const start = afterDate.add(idx * 14, "day");
  const end = start.add(13, "day");
  const dayOfYear = start.diff(dayjs(`${start.format("YYYY")}-01-01`), "day") + 1;
  return {
    name: `${start.format("YYYY")}-${String(Math.ceil(dayOfYear / 14)).padStart(2, "0")}迭代`,
    start: start.format("YYYY-MM-DD"),
    end: end.format("YYYY-MM-DD"),
  };
}

export function genTicket(year: number, seqInYear: number, submittedAt: dayjs.Dayjs): Ticket {
  const code = `GD${year}${String(seqInYear).padStart(6, "0")}`;
  const requester = pick(REQUESTERS);
  const itHandler = pick(IT_HANDLERS);
  const category = pick(CATEGORIES);
  const owningApp = pick(OWNING_APPS);
  const moduleName = pick(MODULES);
  const hasTapd = rand() > 0.15;
  const hasSubTickets = hasTapd && rand() > 0.55;

  // 决定状态（模拟当曲云/TAPD原始状态）
  const statusRoll = rand();
  let status: TicketStatus;
  if (statusRoll < 0.12) status = "待处理";
  else if (statusRoll < 0.2) status = "梳理中";
  else if (statusRoll < 0.55) status = "已梳理";
  else if (statusRoll < 0.62) status = "规划中";
  else if (statusRoll < 0.85) status = "已完成";
  else if (statusRoll < 0.92) status = "已解决";
  else status = "关闭";

  let devStatus: string | null = null;
  if (status === "已梳理") {
    devStatus = pick(DEV_STATUS_BY_STATUS["已梳理"]);
  }
  const stage = resolveStage(status, devStatus);

  const estimatedHours = Number((randInt(4, 80) / 2).toFixed(1));
  const isDone = stage === "已完成" || stage === "关闭";
  const actualHours = isDone
    ? Number((estimatedHours + randInt(-15, 20) / 2).toFixed(1))
    : rand() > 0.5
    ? Number((estimatedHours * (0.2 + rand() * 0.6)).toFixed(1))
    : 0;

  const subTickets = hasSubTickets
    ? Array.from({ length: randInt(2, 4) }).map((_, i) => {
        const dev = pick(DEVELOPERS);
        const iter = makeIteration(submittedAt, i);
        const subEst = Number((randInt(4, 24) / 2).toFixed(1));
        return {
          id: uuid(),
          code: `${code}-${i + 1}`,
          title: `${randomPinyinTitle()}（子需求${i + 1}）`,
          developer: dev.name,
          currentHandler: dev.name,
          monthlyPlan: [dayjs(submittedAt).add(i, "month").format("YYYY-MM")],
          iteration: iter,
          estimatedHours: subEst,
          actualHours: isDone ? Number((subEst + randInt(-4, 4) / 2).toFixed(1)) : 0,
        };
      })
    : [];

  const developer = hasSubTickets
    ? dedupe(subTickets.map((s) => s.developer))
    : hasTapd
    ? [pick(DEVELOPERS).name]
    : [];

  const currentHandler = hasSubTickets
    ? subTickets.map((s) => s.currentHandler).join("、")
    : hasTapd
    ? developer[0] ?? itHandler.name
    : itHandler.name;

  const monthlyPlan = hasSubTickets
    ? dedupe(subTickets.flatMap((s) => s.monthlyPlan))
    : hasTapd
    ? [submittedAt.format("YYYY-MM")]
    : [];

  const iterations = hasSubTickets
    ? (subTickets.map((s) => s.iteration).filter(Boolean) as IterationRef[])
    : hasTapd
    ? [makeIteration(submittedAt, 0)]
    : [];

  const actualHoursTotal = hasSubTickets
    ? Number(subTickets.reduce((sum, s) => sum + s.actualHours, 0).toFixed(1))
    : actualHours;

  const expectedTriage = submittedAt.add(randInt(1, 5), "day");
  const actualTriage = stage !== "待排期" ? expectedTriage.add(randInt(-1, 3), "day") : null;
  const expectedComplete = submittedAt.add(randInt(7, 30), "day");
  const actualComplete = isDone ? expectedComplete.add(randInt(-5, 10), "day") : null;

  const closedAt = stage === "关闭" ? actualComplete?.format("YYYY-MM-DD") ?? null : null;

  const processingNotes = [
    {
      time: submittedAt.format("YYYY-MM-DD HH:mm"),
      actor: requester.name,
      content: "提交工单",
    },
    {
      time: submittedAt.add(1, "day").format("YYYY-MM-DD HH:mm"),
      actor: itHandler.name,
      content: `已接单，归属应用：${owningApp}`,
    },
  ];
  if (stage === "关闭") {
    processingNotes.push({
      time: closedAt ?? submittedAt.format("YYYY-MM-DD HH:mm"),
      actor: itHandler.name,
      content: "工单已关闭（关闭前最后一次处理记录已拼接至处理备注）",
    });
  }

  return {
    id: uuid(),
    code,
    tapdUrl: hasTapd ? `https://www.tapd.cn/mock_workspace/prong/stories/view/${randInt(1000000, 9999999)}` : null,
    category,
    owningApp,
    module: moduleName,
    title: randomPinyinTitle(),
    content: randomContent(),
    attachments: rand() > 0.75 ? [{ name: "需求说明.pdf", url: "#" }] : [],
    requester: requester.name,
    requesterPinyin: requester.pinyin,
    requesterDept: requester.departmentId,
    currentHandler,
    itHandler: itHandler.name,
    developer,
    stage,
    status,
    devStatus,
    urgent: rand() > 0.85,
    isReturned: rand() > 0.9,
    monthlyPlan,
    iterations,
    expectedTriageTime: expectedTriage.format("YYYY-MM-DD"),
    actualTriageTime: actualTriage ? actualTriage.format("YYYY-MM-DD") : null,
    expectedCompleteTime: expectedComplete.format("YYYY-MM-DD"),
    actualCompleteTime: actualComplete ? actualComplete.format("YYYY-MM-DD") : null,
    estimatedHours,
    actualHours: actualHoursTotal,
    submittedAt: submittedAt.format("YYYY-MM-DD HH:mm"),
    closedAt,
    subTickets,
    processingNotes,
    changeHistory: [],
    slaFlag: null,
  };
}

export function generateTickets(): Ticket[] {
  const tickets: Ticket[] = [];
  const startYear = 2024;
  const endDate = dayjs("2026-07-24");
  for (let year = startYear; year <= 2026; year++) {
    const yearStart = dayjs(`${year}-01-01`);
    const yearEnd = year === 2026 ? endDate : dayjs(`${year}-12-31`);
    const daySpan = yearEnd.diff(yearStart, "day");
    const countThisYear = year === 2026 ? 46 : 40;
    let seq = 0;
    const days = Array.from({ length: countThisYear }, () => randInt(0, daySpan)).sort((a, b) => a - b);
    for (const d of days) {
      seq += randInt(1, 3);
      const submittedAt = yearStart.add(d, "day").add(randInt(8, 19), "hour").add(randInt(0, 59), "minute");
      tickets.push(genTicket(year, seq, submittedAt));
    }
  }
  return tickets;
}

export function generateMessages(tickets: Ticket[]): InSiteMessage[] {
  const msgs: InSiteMessage[] = [];
  const recent = [...tickets].sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1)).slice(0, 15);
  recent.forEach((t, i) => {
    msgs.push({
      id: uuid(),
      toRole: "admin",
      requesterName: t.requester,
      action: `更新了工单「${t.title}」的紧急字段`,
      time: dayjs(t.submittedAt).add(1, "hour").format("YYYY-MM-DD HH:mm"),
      ticketCode: t.code,
      read: i > 4,
    });
  });
  return msgs;
}

export function generateLogs(): LogEntry[] {
  const types: LogEntry["type"][] = ["获取新工单", "更新工单", "同步TAPD"];
  return Array.from({ length: 20 }).map((_, i) => {
    const success = rand() > 0.15;
    return {
      id: uuid(),
      type: pick(types),
      time: dayjs("2026-07-24").subtract(i, "hour").format("YYYY-MM-DD HH:mm"),
      actor: pick(IT_HANDLERS).name,
      success,
      failReason: success ? null : pick(["TAPD接口超时", "字段校验失败", "网络异常", "权限校验失败"]),
      detail: success ? "执行成功" : "执行失败，已记录变更日志",
    };
  });
}
