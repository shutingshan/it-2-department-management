import { store } from "./store";

/**
 * 能否进入缺陷跟进：由管理员在「账号配置」里逐个账号勾选，管理员本身不受限。
 *
 * 这是一道"准入"判断，不是逐行过滤——通过就能看到并编辑全部缺陷，没通过则一条也看不到。
 * 缺陷跟进是参与者共用的协作看板，只看自己那几条没法交叉跟进；而谁算参与者不从
 * 工单数据里推断（那样新同事在第一条缺陷落到自己头上之前会一直进不去，
 * 且管理员没有任何手动放行的入口），改为显式授权。
 *
 * 刻意只收 actor 一个参数：角色一律以账号记录为准。之前还收一个 actorRole 并对
 * "admin" 直接放行，但那个值是前端传上来的，等于谁传 actorRole=admin 谁就是管理员；
 * 同理不传 actor 也不能当成"内部调用"放行——匿名请求应当直接拒绝。
 *
 * 放在这里而不是 filter.ts：filter.ts 不能引用 store（store 反过来要用 filter 的
 * 范围函数），引进来就成了循环依赖。
 */
export function canAccessDefects(actor?: string): boolean {
  if (!actor) return false;
  const account = store.accounts.find((a) => a.name === actor);
  if (!account) return false;
  if (account.role === "admin") return true;
  return !!account.menuPermissions?.includes("defects");
}
