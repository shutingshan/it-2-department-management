/**
 * 人员目录：以真实工单数据里出现过的人为准，而不是 seed.ts 里预置的那份示例名单。
 *
 * 背景：seed.ts 里的人员（陈志明、林嘉怡……）是原型阶段编的示例数据，跟当曲云同步回来的
 * 真实受理人/发起人（单术婷、王婷婷(IT)、程昊……）对不上，导致真人拿不到账号、登不进系统。
 * 这里改为从工单数据里汇总出真实人员，管理员在"账号管理"页面从这份目录里挑人授权即可。
 *
 * 拼音码留空：中文转拼音需要额外的字典依赖，而登录接口本来就支持用姓名匹配
 * （见 routes/auth.ts），真人直接输自己的中文名就能登录，不依赖拼音码。
 */
import { Department, Role, Ticket, User } from "./types";

// 多人字段里可能出现的分隔符，跟当曲云抓取那边保持一致
const NAME_SEPARATORS = /[、,，;；]/;

function splitNames(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(NAME_SEPARATORS)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 同一个人每次都要拿到同一个颜色，否则每次重启/数据变动头像颜色都在变。
// 用名字算一个稳定哈希再取色板里的一项
const AVATAR_COLORS = [
  "#2f54eb",
  "#13a8a8",
  "#722ed1",
  "#eb2f96",
  "#fa8c16",
  "#52c41a",
  "#1677ff",
  "#f5222d",
  "#a0d911",
  "#faad14",
  "#597ef7",
  "#36cfc9",
];

function colorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// 人员 id 必须跟着姓名稳定：账号表里存的是 userId，id 一变已授权的账号就对不上人了
export function userIdForName(name: string): string {
  return `u-name-${name}`;
}

// 角色只做粗粒度推断，且按优先级取其一：一个人可能既是某单的受理人又是另一单的发起人，
// 这里以"在 IT 侧承担的角色"优先。注意能登录的只有 admin/it_handler/requester
// （见 types.ts 的 AccountRole），developer 仅作为工单数据里的人员标签存在
function inferRole(name: string, sets: { handlers: Set<string>; developers: Set<string> }): Role {
  if (sets.handlers.has(name)) return "it_handler";
  if (sets.developers.has(name)) return "developer";
  return "requester";
}

/**
 * 从工单数据汇总人员目录。
 *
 * @param seedAdmin seed 里那个锁定的默认管理员——必须始终保留：工单数据为空时（比如全新部署
 *                  还没同步过数据）目录会是空的，没有他就没有任何人能登录、也没人能去授权别人。
 */
export function buildUserDirectory(
  tickets: Ticket[],
  departments: Department[],
  seedAdmin: User
): User[] {
  const handlers = new Set<string>();
  const developers = new Set<string>();
  const all = new Set<string>();
  // 发起人 -> 发起部门名称（取最近一次出现的），用于尽量给需求方带上部门
  const deptNameByName = new Map<string, string>();

  for (const t of tickets) {
    const handler = t.itHandler?.trim();
    if (handler) {
      handlers.add(handler);
      all.add(handler);
    }

    for (const dev of t.developer ?? []) {
      const d = dev.trim();
      if (d) {
        developers.add(d);
        all.add(d);
      }
    }

    const requester = t.requester?.trim();
    if (requester) {
      all.add(requester);
      const dept = t.requesterDept?.trim();
      if (dept) deptNameByName.set(requester, dept);
    }

    // 当前处理人可能是多个人顿号拼接（有子需求时由子需求汇总而来）；
    // 关注人本身就是数组。这两类只用于补全人员名单，不参与角色推断——
    // 处理人既可能是开发也可能是受理人，关注人更是没有角色含义，猜了容易猜错
    for (const n of splitNames(t.currentHandler)) all.add(n);
    for (const w of t.watcher ?? []) {
      const n = w.trim();
      if (n) all.add(n);
    }
  }

  // 发起部门在工单里存的是当曲云的部门名称文本，而部门树用的是内部 id。
  // 这里按名称去部门树里找对应的 id，找得到就带上——等部门树按真实名称配好后自然就对上了，
  // 对不上就留空，不影响登录与账号授权
  const deptIdByName = new Map(departments.map((d) => [d.name, d.id]));

  const derived: User[] = Array.from(all)
    .filter((name) => name !== seedAdmin.name) // 管理员单独放在最前面，避免重复
    .sort()
    .map((name) => ({
      id: userIdForName(name),
      name,
      pinyin: "",
      role: inferRole(name, { handlers, developers }),
      departmentId: deptIdByName.get(deptNameByName.get(name) ?? "") ?? "",
      avatarColor: colorForName(name),
    }));

  return [seedAdmin, ...derived];
}
