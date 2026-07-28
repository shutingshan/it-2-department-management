/**
 * TAPD 开放平台 API 取数（替代此前的浏览器自动化抓取）。
 *
 * 相比浏览器方案的好处：不会被 WAF 拦截、不用扫码登录、不弹窗口、不受页面改版影响，
 * 定时任务可以真正无人值守跑起来。需要在 backend/.env 配置 TAPD_API_USER / TAPD_API_PASSWORD
 * （由 TAPD 公司管理员在后台单独开通的"API账号/口令"，不是登录用的账号密码）。
 *
 * 字段口径按工单字段表：
 * - TAPD状态   <- story.status（API 返回的是状态英文标识，需再查一次状态映射表翻成中文，
 *                 因为工单阶段的计算规则 resolveStage 匹配的是"已规划/实现中/转测试"这类中文值）
 * - 预估工时   <- story.effort
 * - 完成工时   <- story.effort_completed
 * - 开发人员   <- story.developer
 * - 处理人     <- story.owner
 *
 * 注意：字段名与返回结构按 TAPD 开放平台文档实现，尚未用真实账号跑通验证过；
 * 若实际返回结构与此不符，把接口原始返回发回来即可快速对齐。
 */
import { config } from "../config";

// 子需求（父需求下的子 story）字段，展示在工单的"子需求"弹窗里
export interface TapdSubStoryFields {
  storyId: string;
  title: string;
  tapdUrl: string | null;
  tapdStatus: string | null;
  developer: string[];
  tester: string[];
  currentHandler: string | null;
  estimatedHours: number | null;
  actualHours: number | null;
  iterationName: string | null;
}

export interface TapdStoryFields {
  tapdStatus: string | null;
  estimatedHours: number | null;
  actualHours: number | null;
  developer: string[];
  tester: string[];
  currentHandler: string | null;
  // 迭代：API 模式能拿到名称与起止日期；浏览器模式只能拿到页面上显示的名称
  iterationName: string | null;
  iterationStart: string | null;
  iterationEnd: string | null;
  // 月度计划：TAPD 上一般是自定义字段，各空间字段名不同；取不到时为空数组（保持工单原值不动）
  monthlyPlan: string[];
  // 子需求列表；null 表示本次没有尝试/没能获取子需求（保持工单原值不动），空数组表示确认没有子需求
  subStories: TapdSubStoryFields[] | null;
  // 在 TAPD 上确认为空（页面显示"-"或接口返回空值）的字段中文名。
  // 用来区分"抓取失败没读到"和"TAPD上本来就没填"：前者保持工单原值不动，
  // 后者要把工单里的值一并清空，保证两边一致
  emptyFields: string[];
}

// 工单里存的"关联TAPD"地址实测有多种格式，都能拿到空间id与需求id：
// https://www.tapd.cn/tapd_fe/<空间id>/story/detail/<需求id>
// https://www.tapd.cn/<空间id>/prong/stories/view/<需求id>
export function parseTapdRef(tapdUrl: string): { workspaceId: string; storyId: string } | null {
  const workspaceId = tapdUrl.match(/tapd\.cn\/(?:tapd_fe\/)?(\d+)\b/)?.[1];
  // 需求id统一取路径末尾的纯数字段（两种地址格式下都是需求id）；
  // 先剥掉查询串/hash和结尾斜杠再取，避免正则从更早的数字段（比如空间id）就匹配成功
  const pathOnly = tapdUrl.split(/[?#]/)[0].replace(/\/+$/, "");
  const storyId = pathOnly.match(/(\d+)$/)?.[1];
  if (!workspaceId || !storyId) return null;
  return { workspaceId, storyId };
}

async function apiGet(path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(path, config.tapd.apiBaseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const auth = Buffer.from(`${config.tapd.apiUser}:${config.tapd.apiPassword}`).toString("base64");
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(60000),
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error("TAPD API 认证失败：请检查 backend/.env 里的 TAPD_API_USER / TAPD_API_PASSWORD 是否正确");
  }
  if (!res.ok) {
    throw new Error(`TAPD API 请求失败（HTTP ${res.status}）：${(await res.text()).slice(0, 200)}`);
  }

  const body = await res.json();
  // TAPD 统一响应格式：{ status: 1, data: ..., info: "success" }，status 非 1 即为业务错误
  if (body?.status !== 1) {
    throw new Error(`TAPD API 返回错误：${body?.info ?? JSON.stringify(body).slice(0, 200)}`);
  }
  return body.data;
}

// 状态映射表（英文标识 -> 中文名）按空间维度缓存：同一次批量同步里几十条工单通常同属少数几个空间，
// 没必要每条都重新拉一次；进程重启后自然失效，够用
const statusMapCache = new Map<string, Record<string, string>>();

async function getStatusMap(workspaceId: string): Promise<Record<string, string>> {
  const cached = statusMapCache.get(workspaceId);
  if (cached) return cached;
  // 状态映射跟工作流配置绑定，取不到时不影响主流程，退化成直接用英文标识
  const data = await apiGet("/workflows/status_map", { workspace_id: workspaceId, system: "story" }).catch(
    () => null
  );
  const map = (data && typeof data === "object" ? (data as Record<string, string>) : {}) ?? {};
  statusMapCache.set(workspaceId, map);
  return map;
}

// 工时字段可能是数字、纯数字字符串，也可能带单位（如 "8h"）；取不到有效数值时返回 null，
// 由调用方决定"保持原值不动"，避免把抓取失败误写成 0
function parseHours(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// 多人字段 TAPD 用分号分隔（如 "张三;李四;"），兼容顿号/逗号
function parseNameList(v: unknown): string[] {
  if (!v) return [];
  return Array.from(
    new Set(
      String(v)
        .split(/[;；、,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

// 迭代信息按 (空间id, 迭代id) 缓存，同一批工单往往同属少数几个迭代
const iterationCache = new Map<string, { name: string; start: string | null; end: string | null } | null>();

async function getIteration(
  workspaceId: string,
  iterationId: string
): Promise<{ name: string; start: string | null; end: string | null } | null> {
  const key = `${workspaceId}:${iterationId}`;
  if (iterationCache.has(key)) return iterationCache.get(key) ?? null;
  const data = await apiGet("/iterations", { workspace_id: workspaceId, id: iterationId }).catch(() => null);
  const raw = Array.isArray(data) ? data[0] : data;
  const iteration = raw?.Iteration ?? raw;
  const result = iteration?.name
    ? {
        name: String(iteration.name),
        start: iteration.startdate ? String(iteration.startdate) : null,
        end: iteration.enddate ? String(iteration.enddate) : null,
      }
    : null;
  iterationCache.set(key, result);
  return result;
}

// story 原始对象 -> 子需求字段（子需求与父需求同为 story，字段口径一致）
function toSubStoryFields(story: any, workspaceId: string, statusMap: Record<string, string>): TapdSubStoryFields {
  const rawStatus = story.status ? String(story.status) : "";
  return {
    storyId: String(story.id ?? ""),
    title: String(story.name ?? ""),
    tapdUrl: story.id ? `https://www.tapd.cn/tapd_fe/${workspaceId}/story/detail/${story.id}` : null,
    tapdStatus: rawStatus ? statusMap[rawStatus] ?? rawStatus : null,
    developer: parseNameList(story.developer),
    tester: parseNameList(story.tester),
    currentHandler: parseNameList(story.owner)[0] ?? null,
    estimatedHours: parseHours(story.effort),
    actualHours: parseHours(story.effort_completed),
    iterationName: null, // 子需求的迭代名需要额外按 iteration_id 查询，由调用处统一补齐
  };
}

export async function fetchTapdStoryFields(tapdUrl: string): Promise<TapdStoryFields> {
  const ref = parseTapdRef(tapdUrl);
  if (!ref) {
    throw new Error(`无法从TAPD地址中解析出空间id/需求id：${tapdUrl}`);
  }

  const data = await apiGet("/stories", { workspace_id: ref.workspaceId, id: ref.storyId });
  // 按 id 查询时返回的是数组，每个元素形如 { Story: {...} }；也兼容直接返回单个对象的情况
  const raw = Array.isArray(data) ? data[0] : data;
  const story = raw?.Story ?? raw;
  if (!story || typeof story !== "object") {
    throw new Error(`TAPD 未返回该需求的数据（空间id ${ref.workspaceId}，需求id ${ref.storyId}），请确认该需求是否存在、API账号是否有该空间权限`);
  }

  const statusMap = await getStatusMap(ref.workspaceId);
  const rawStatus = story.status ? String(story.status) : "";
  // 映射表里查不到就直接用原始值，至少不会丢数据
  const tapdStatus = rawStatus ? statusMap[rawStatus] ?? rawStatus : null;

  // 迭代：story 上只有 iteration_id，名称/起止日期要再查一次迭代接口
  const iteration =
    story.iteration_id && String(story.iteration_id) !== "0"
      ? await getIteration(ref.workspaceId, String(story.iteration_id))
      : null;

  // 子需求：同一空间下 parent_id 等于本需求 id 的 story 即为子需求。
  // 查询失败时置为 null（保持工单原有子需求数据不动），查询成功但为空数组则表示确认没有子需求
  let subStories: TapdSubStoryFields[] | null = null;
  try {
    const childData = await apiGet("/stories", {
      workspace_id: ref.workspaceId,
      parent_id: ref.storyId,
      limit: "100",
    });
    const list = Array.isArray(childData) ? childData : childData ? [childData] : [];
    subStories = [];
    for (const item of list) {
      const child = item?.Story ?? item;
      if (!child || typeof child !== "object" || !child.id) continue;
      const sub = toSubStoryFields(child, ref.workspaceId, statusMap);
      if (child.iteration_id && String(child.iteration_id) !== "0") {
        sub.iterationName = (await getIteration(ref.workspaceId, String(child.iteration_id)))?.name ?? null;
      }
      subStories.push(sub);
    }
  } catch {
    subStories = null;
  }

  // API 一定会把字段带回来，所以"返回了但值为空"就等于TAPD上确实没填，可以放心清空工单里的值。
  // 月度计划是各空间自定义字段（字段名不统一），API模式不取，因此不参与清空判断
  const isEmpty = (v: unknown) => v === null || v === undefined || String(v).trim() === "";
  const emptyFields: string[] = [];
  if (isEmpty(story.status)) emptyFields.push("TAPD状态");
  if (isEmpty(story.effort)) emptyFields.push("预估工时");
  if (isEmpty(story.effort_completed)) emptyFields.push("完成工时");
  if (isEmpty(story.developer)) emptyFields.push("开发人员");
  if (isEmpty(story.tester)) emptyFields.push("测试人员");
  if (isEmpty(story.owner)) emptyFields.push("处理人");
  if (!iteration) emptyFields.push("迭代");

  return {
    tapdStatus,
    estimatedHours: parseHours(story.effort),
    actualHours: parseHours(story.effort_completed),
    developer: parseNameList(story.developer),
    tester: parseNameList(story.tester),
    currentHandler: parseNameList(story.owner)[0] ?? null,
    iterationName: iteration?.name ?? null,
    iterationStart: iteration?.start ?? null,
    iterationEnd: iteration?.end ?? null,
    // 月度计划在TAPD上一般是各空间自定义字段，字段名不统一，API模式暂不取；保持工单原值
    monthlyPlan: [],
    subStories,
    emptyFields,
  };
}
