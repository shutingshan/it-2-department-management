/**
 * 一次性清理脚本：把本地工单编号跟当曲云列表比对，本地有、当曲云没有的视为已在当曲云删除，
 * 从本地一并删掉。用完即可删除本文件，不在页面上留常驻入口。
 *
 *   cd backend && npm run cleanup:removed
 *
 * 这是不可逆操作，而"当曲云列表里没有"这个判断本身并不完全可靠——当曲云那个列表页可能存着
 * 筛选条件（分类、状态、受理人等），被筛掉的工单同样会表现为"没有"。所以脚本做成两步：
 * 先把将要删除的编号全部打印出来，人工核对确认后再敲回车才真删；真删前还会把整份数据备份一次。
 */
import readline from "readline";
import { store, backupStoreFile } from "../store";
import { scrapeDangquyunTicketList } from "../scrapers/dangquyunScraper";

function waitForConfirm(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log(`[cleanup] 本地现有工单：${store.tickets.length} 条`);
  if (store.tickets.length === 0) {
    console.log("[cleanup] 本地没有工单，无需清理。");
    return;
  }

  console.log("[cleanup] 开始抓取当曲云工单列表用于比对（耗时跟“获取新工单”相当，请耐心等待）…");
  const result = await scrapeDangquyunTicketList();

  // 跟获取新工单/更新工单同一套校验口径：抓错列表时绝不能拿来做删除判断
  if (result.strategy === "none") {
    throw new Error(
      "未能识别当曲云工单列表页面结构，本次清理判定无效（截图/HTML 已存到 backend/.auth/debug/）"
    );
  }

  const scrapedCodes = new Set(
    result.rows.map((r) => r["编号"]?.trim()).filter((c): c is string => !!c)
  );
  if (scrapedCodes.size === 0) {
    throw new Error("当曲云列表一条工单编号都没抓到，本次清理判定无效");
  }

  // 已完成工单核验：挑本地最近完成的一条，它必须还能在当曲云列表里找到。
  // 找不到说明这次抓到的根本不是预期的那份列表，宁可不清理也不能误删
  const completed = store.tickets.filter((t) => t.stage === "已完成");
  if (completed.length > 0) {
    const verifyTicket = [...completed].sort((a, b) =>
      (b.actualCompleteTime ?? b.submittedAt).localeCompare(a.actualCompleteTime ?? a.submittedAt)
    )[0];
    if (!scrapedCodes.has(verifyTicket.code)) {
      throw new Error(`当前工单列表与要求列表不符。工单验证编号：${verifyTicket.code}`);
    }
    console.log(`[cleanup] 已完成工单核验通过（验证编号：${verifyTicket.code}）`);
  }

  const missing = store.tickets.filter((t) => !scrapedCodes.has(t.code));
  console.log(
    `[cleanup] 当曲云抓到 ${scrapedCodes.size} 条（${result.pageCount} 页），` +
      `本地 ${store.tickets.length} 条，其中 ${missing.length} 条在当曲云列表里没找到。`
  );

  if (missing.length === 0) {
    console.log("[cleanup] 没有需要清理的工单，本地数据跟当曲云一致。");
    return;
  }

  console.log("\n[cleanup] 以下工单将被删除：");
  missing.forEach((t) => console.log(`  ${t.code}  ${t.stage}  ${t.title ?? ""}`));

  console.log(
    "\n[cleanup] 请先核对上面的清单。若当曲云那个列表页存着筛选条件（分类/状态/受理人等），" +
      "被筛掉的工单同样会出现在这里，删了就是误删。"
  );
  const answer = await waitForConfirm(`[cleanup] 确认删除这 ${missing.length} 条？输入 yes 继续，其它任意键取消：`);
  if (answer.toLowerCase() !== "yes") {
    console.log("[cleanup] 已取消，未做任何改动。");
    return;
  }

  const backupFile = backupStoreFile();
  console.log(`[cleanup] 删除前已备份：backend/data/${backupFile ?? "(备份失败，请留意)"}`);

  const removed = new Set(missing.map((t) => t.code));
  store.tickets = store.tickets.filter((t) => !removed.has(t.code));
  store.save();

  console.log(`[cleanup] 完成：已删除 ${removed.size} 条，本地剩余 ${store.tickets.length} 条。`);
  if (backupFile) {
    console.log(`[cleanup] 如需回滚：把 backend/data/${backupFile} 改名为 store.json 覆盖回去即可。`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[cleanup] 失败：", (e as Error).message ?? e);
    process.exit(1);
  });
