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

// 后端服务每 5 秒会把它内存里的数据自动落盘一次。如果它正开着，本脚本删完写入 store.json 后，
// 会被后端那份"还没删过的"内存数据覆盖回去——清理白做，甚至可能两边同时写导致文件损坏。
// 所以跑之前必须先把后端停掉，这里主动探测一下，别等用户白跑一趟才发现
async function assertBackendNotRunning() {
  const port = process.env.PORT ?? 4000;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      throw new Error(
        `检测到后端服务正在运行（localhost:${port}）。它每 5 秒会自动落盘一次，` +
          `会把本次清理的结果覆盖掉。请先在跑后端的那个终端按 Ctrl+C 停掉服务，再执行本脚本。`
      );
    }
  } catch (e) {
    // 连不上（ECONNREFUSED / abort）说明后端没跑，正是我们要的；只有上面主动抛的那个才往外传
    if (e instanceof Error && e.message.includes("检测到后端服务正在运行")) throw e;
  }
}

async function main() {
  await assertBackendNotRunning();

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

  // 当曲云表格是虚拟滚动：一页最多 200 条，必须滚到底才能把整页的行都渲染出来。
  // 只要有任意一页没能确认"已滚到不再增长"（滚动加载超时），抓到的就可能只是该页的一部分，
  // 那些没被渲染出来的工单会被误判成"当曲云已删除"而永久删掉，绝不能继续
  if (result.scrollIncomplete) {
    throw new Error(
      "当曲云列表存在滚动加载未完成的页（可能没抓全），为避免把没抓到的工单误删，本次清理判定无效。" +
        "请稍后网络状况好一些时重试。"
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
