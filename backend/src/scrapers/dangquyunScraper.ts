import fs from "fs";
import path from "path";
import { Frame, Page } from "playwright";
import { getAuthenticatedContext, launchBrowser } from "./dangquyunAuth";
import { config } from "../config";

const DEBUG_DIR = path.join(__dirname, "../../.auth/debug");
const MAX_PAGES = 60; // 安全上限，防止分页逻辑出问题时无限翻页

export interface ScrapedRow {
  [columnHeader: string]: string;
}

export type ExtractStrategy = "dangqu-virtual-grid" | "dangqu-grid" | "native-table" | "aria-grid";

export interface ScrapeResult {
  rows: ScrapedRow[];
  strategy: ExtractStrategy | "none";
  pageCount: number;
  // 任意一页的滚动加载没能确认"已全部加载"（超时退出）时为 true：
  // 此时 rows 可能只是该页的一部分，不能用于"没抓到就等于已删除"这类判断
  scrollIncomplete: boolean;
}

// 滚动加载完整性标记，在一次抓取的多页之间共享
interface ScrollStat {
  incomplete: boolean;
}

type Locatable = Page | Frame;

// 首屏冷启动超时（微前端首次加载几十个远程 chunk，观察到偏慢，放宽到 4 分钟）
const FIRST_PAGE_TIMEOUT_MS = 240000;
// 翻页超时：应用已经加载完成，翻页只是同一个已挂载模块内部重新请求/渲染数据，
// 不需要再等首屏那么久；等太久反而会让"获取新工单"这个同步 HTTP 请求整体超时更容易被
// 客户端提前放弃，与并发锁互相踩踏，所以单独给一个短得多的超时（但要给下面的滚动加载留够时间）
const PAGINATION_TIMEOUT_MS = 60000;

// 当曲云是微前端架构（主壳先渲染出来，工单列表本身由独立的远程模块异步加载挂载进来），
// 首屏渲染出来时列表模块可能压根还没开始渲染，此时既没有文字也没有 antd 的加载中转圈（class
// 带 spin-spinning），"没转圈=已加载完成"的判断会误判。所以不区分"等转圈消失"和"抓取"两步，
// 而是直接反复尝试抓取，抓到数据或者彻底超时才停止
async function waitForFirstPageData(
  targets: Locatable[],
  timeoutMs: number,
  stat?: ScrollStat
): Promise<{ rows: ScrapedRow[]; strategy: ExtractStrategy } | null> {
  const deadline = Date.now() + timeoutMs;
  let lastAttempt: { rows: ScrapedRow[]; strategy: ExtractStrategy } | null = null;
  while (Date.now() < deadline) {
    lastAttempt = await extractCurrentPage(targets, stat);
    if (lastAttempt) return lastAttempt;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return lastAttempt;
}

// 当曲云表格是虚拟滚动列表：一页最多 200 条，但同一时刻 DOM 里只渲染视口内的那一小部分行，
// 必须不断把表格滚动到底部触发懒加载，直到渲染出的行数不再增长（连续几次都一样）才算真正
// 拿到本页全部数据，否则只会抓到滚动条顶部那几十条
// 返回值里的 stabilized 表示"是不是真的滚到不再增长才结束"：超时退出时行数可能只收了一部分，
// 但返回的数字看起来跟正常收全没有区别。对"获取新工单"来说少抓几条下次会补上，
// 但对清理脚本（按"当曲云列表里没有"来删除本地工单）来说，没抓全就等于误删，
// 必须把这个区别暴露出去让调用方自己决定要不要采信
async function scrollGridToLoadAll(
  target: Locatable,
  rowSelector: string,
  timeoutMs = 60000
): Promise<{ count: number; stabilized: boolean }> {
  const rowLocator = target.locator(rowSelector);
  const deadline = Date.now() + timeoutMs;
  let lastCount = await rowLocator.count();
  let stableRounds = 0;
  while (Date.now() < deadline && stableRounds < 3) {
    await target
      .evaluate((selector) => {
        const row = document.querySelector(selector);
        if (!row) return;
        let el: HTMLElement | null = row as HTMLElement;
        while (el && el !== document.body) {
          const style = getComputedStyle(el);
          if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 10) {
            el.scrollTop = el.scrollHeight;
            return;
          }
          el = el.parentElement;
        }
        window.scrollTo(0, document.body.scrollHeight);
      }, rowSelector)
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    const count = await rowLocator.count();
    if (count === lastCount) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
      lastCount = count;
    }
  }
  return { count: lastCount, stabilized: stableRounds >= 3 };
}

// 表头文字。class 带编译哈希（columnItemHeaderTitle___3CMa-），用 class*= 前缀匹配
const HEADER_SELECTOR = '[class*="columnItemHeaderTitle"] [class*="titleSpanTitle"]';

// 勾选框/序号这类非数据列，不参与表头对齐
function isUiOnlyColumn(nodeId: string): boolean {
  return nodeId.includes("selection") || nodeId.includes("serial");
}

/** 从页面上取回来的单元格原始信息（见 extractFromVirtualGrid 的 evaluateAll） */
export interface GridCell {
  rowKey: string;
  nodeId: string;
  left: number;
  top: number;
  text: string;
}

/**
 * 把扁平的单元格还原成行：按 rowKey 分组、行间按 top 排序、行内按 left 排成列，再跟表头对齐。
 * 抽成纯函数是为了不起浏览器也能验证这段最容易出错的逻辑。
 */
export function buildRowsFromGridCells(
  cells: GridCell[],
  headers: string[]
): { rows: ScrapedRow[]; headerMismatch: number } {
  const byRow = new Map<string, GridCell[]>();
  for (const cell of cells) {
    if (!cell.rowKey || isUiOnlyColumn(cell.nodeId)) continue;
    const list = byRow.get(cell.rowKey);
    if (list) list.push(cell);
    else byRow.set(cell.rowKey, [cell]);
  }

  const rows: ScrapedRow[] = [];
  let headerMismatch = 0;
  // 行间顺序按 top；同一行的单元格 top 相同，取第一个即可
  const ordered = Array.from(byRow.values()).sort((a, b) => a[0].top - b[0].top);
  for (const rowCells of ordered) {
    // 固定列与滚动列可能分属两个容器、left 各自从 0 起算，同一行里会出现重复 left；
    // 先按 nodeId 去重，保证一列只取一个单元格
    // 必须单次遍历去重：filter + map 两段写法里 filter 会先整轮跑完，
    // 那时 seen 还是空的，等于没去重
    const seen = new Set<string>();
    const sorted: GridCell[] = [];
    for (const cell of rowCells) {
      if (cell.nodeId) {
        if (seen.has(cell.nodeId)) continue;
        seen.add(cell.nodeId);
      }
      sorted.push(cell);
    }
    sorted.sort((a, b) => a.left - b.left);
    if (sorted.length === 0) continue;
    if (headers.length > 0 && sorted.length !== headers.length) headerMismatch += 1;

    const row: ScrapedRow = {};
    sorted.forEach((c, idx) => {
      row[headers[idx] || `col${idx}`] = c.text;
    });
    rows.push(row);
  }
  return { rows, headerMismatch };
}

/**
 * 当曲云新版表格（lumi 虚拟网格）：DOM 里**没有行元素**。
 * 每个单元格都是扁平的绝对定位 div，靠属性标明归属：
 *   data-gridrowkey="<行id>"   同一行的单元格共用
 *   data-nodeid="<列id>"       列标识；勾选列是 lumi_table_selection_key
 *   style.left                 决定它在第几列（视觉顺序）
 *   style.top                  决定它在第几行（视觉顺序）
 *
 * 所以这里按 gridrowkey 分组成行、按 left 排成列，再跟表头按序对齐。
 * 旧版那套 data-row-item / data-columnitem 的嵌套结构见 extractFromLegacyGrid。
 */
async function extractFromVirtualGrid(
  target: Locatable,
  stat?: ScrollStat
): Promise<ScrapedRow[] | null> {
  const cellSelector = "[data-gridrowkey]";
  if ((await target.locator(cellSelector).count()) === 0) return null;

  // 虚拟滚动：一页 200 条但 DOM 只渲染视口内的十几行，必须滚到底部把本页全部加载出来
  const scrolled = await scrollGridToLoadAll(target, cellSelector);
  if (!scrolled.stabilized && stat) {
    stat.incomplete = true;
    console.warn(
      `[dangquyun] 本页滚动加载超时，已渲染 ${scrolled.count} 个单元格但未确认是否已全部加载，本次抓取结果可能不完整`
    );
  }

  // 一次性把所有单元格的归属与位置取回来，避免逐个 locator 往返（一页上千个单元格会非常慢）
  const cells = await target.locator(cellSelector).evaluateAll((els) =>
    els.map((el) => {
      const h = el as HTMLElement;
      return {
        rowKey: h.getAttribute("data-gridrowkey") ?? "",
        nodeId: h.getAttribute("data-nodeid") ?? "",
        left: Number.parseFloat(h.style.left || "0") || 0,
        top: Number.parseFloat(h.style.top || "0") || 0,
        text: (h.innerText || h.textContent || "").trim(),
      };
    })
  );
  if (cells.length === 0) return null;

  const headers = (await target.locator(HEADER_SELECTOR).allTextContents()).map((h) => h.trim());

  const { rows, headerMismatch } = buildRowsFromGridCells(cells, headers);
  if (rows.length === 0) return null;

  if (headerMismatch > 0) {
    // 列数对不上时字段会错位，必须说清楚，否则会悄悄落一批列名是 col3/col4 的脏数据
    console.warn(
      `[dangquyun] 有 ${headerMismatch}/${rows.length} 行的单元格数与表头数（${headers.length}）不一致，` +
        "对应列会退化成 col0/col1 这类占位列名，字段映射可能错位"
    );
  }
  return rows.length > 0 ? rows : null;
}

// 当曲云旧版表格结构：每一行用 data-row-item="true" 标记、每个单元格用 data-columnitem 标记。
// 2026-10 改版后已不再出现，保留作为兜底，万一不同租户/版本还在用老结构
async function extractFromLegacyGrid(
  target: Locatable,
  stat?: ScrollStat
): Promise<ScrapedRow[] | null> {
  const rowSelector = '[data-row-item="true"]';
  const rowLocator = target.locator(rowSelector);
  let rowCount = await rowLocator.count();
  if (rowCount === 0) return null;

  // 已经渲染出至少一行，说明表格已经挂载好了，接下来滚动到底部把本页剩余的行也加载出来
  const scrolled = await scrollGridToLoadAll(target, rowSelector);
  rowCount = scrolled.count;
  // 只要有任意一页没能滚到"行数不再增长"就整体标记为可能没抓全
  if (!scrolled.stabilized && stat) {
    stat.incomplete = true;
    console.warn(
      `[dangquyun] 本页滚动加载超时，已渲染 ${rowCount} 行但未确认是否已全部加载，本次抓取结果可能不完整`
    );
  }

  const headers = await target.locator(HEADER_SELECTOR).allTextContents();

  const rows: ScrapedRow[] = [];
  for (let i = 0; i < rowCount; i++) {
    const cells = await rowLocator.nth(i).locator("[data-columnitem]").allTextContents();
    if (cells.length === 0) continue;
    const row: ScrapedRow = {};
    cells.forEach((c, idx) => {
      const key = headers[idx]?.trim() || `col${idx}`;
      row[key] = c.trim();
    });
    rows.push(row);
  }
  return rows.length > 0 ? rows : null;
}

// 原生 <table> 结构提取
async function extractFromNativeTable(target: Locatable): Promise<ScrapedRow[] | null> {
  const table = target.locator("table").first();
  if ((await table.count()) === 0) return null;

  const headers = await table.locator("thead th").allTextContents();
  if (headers.length === 0) return null;

  const bodyRows = table.locator("tbody tr");
  const rowCount = await bodyRows.count();
  const rows: ScrapedRow[] = [];
  for (let i = 0; i < rowCount; i++) {
    const cells = await bodyRows.nth(i).locator("td").allTextContents();
    const row: ScrapedRow = {};
    headers.forEach((h, idx) => {
      row[h.trim() || `col${idx}`] = (cells[idx] ?? "").trim();
    });
    rows.push(row);
  }
  return rows;
}

// 很多现代表格组件（antd 等）用 div + ARIA role 模拟表格，而非原生 <table>
async function extractFromAriaGrid(target: Locatable): Promise<ScrapedRow[] | null> {
  const headerCells = target.locator('[role="columnheader"]');
  const headerCount = await headerCells.count();
  if (headerCount === 0) return null;
  const headers = await headerCells.allTextContents();

  const rowLocator = target.locator('[role="row"]');
  const rowCount = await rowLocator.count();
  const rows: ScrapedRow[] = [];
  for (let i = 0; i < rowCount; i++) {
    const r = rowLocator.nth(i);
    const cellLocator = r.locator('[role="cell"], [role="gridcell"]');
    const cellCount = await cellLocator.count();
    if (cellCount === 0) continue; // 跳过表头自身这一行
    const cells = await cellLocator.allTextContents();
    const row: ScrapedRow = {};
    headers.forEach((h, idx) => {
      row[h.trim() || `col${idx}`] = (cells[idx] ?? "").trim();
    });
    rows.push(row);
  }
  return rows.length > 0 ? rows : null;
}

async function extractCurrentPage(
  targets: Locatable[],
  stat?: ScrollStat
): Promise<{ rows: ScrapedRow[]; strategy: ExtractStrategy } | null> {
  for (const target of targets) {
    const rows = await extractFromVirtualGrid(target, stat).catch(() => null);
    if (rows) return { rows, strategy: "dangqu-virtual-grid" };
  }
  for (const target of targets) {
    const rows = await extractFromLegacyGrid(target, stat).catch(() => null);
    if (rows) return { rows, strategy: "dangqu-grid" };
  }
  for (const target of targets) {
    const rows = await extractFromNativeTable(target).catch(() => null);
    if (rows) return { rows, strategy: "native-table" };
  }
  for (const target of targets) {
    const rows = await extractFromAriaGrid(target).catch(() => null);
    if (rows) return { rows, strategy: "aria-grid" };
  }
  return null;
}

// 标准 antd 分页组件：下一页按钮 class 含 ant-pagination-next，
// 到最后一页时会带 ant-pagination-disabled class 且 aria-disabled="true"
async function goToNextPage(targets: Locatable[]): Promise<boolean> {
  for (const target of targets) {
    const nextBtn = target.locator(".ant-pagination-next");
    if ((await nextBtn.count()) === 0) continue;
    const disabled = await nextBtn.first().getAttribute("aria-disabled");
    const classAttr = (await nextBtn.first().getAttribute("class")) ?? "";
    if (disabled === "true" || classAttr.includes("ant-pagination-disabled")) {
      return false;
    }
    await nextBtn.first().click();
    return true;
  }
  return false;
}

function dedupeByCode(allRows: ScrapedRow[]): ScrapedRow[] {
  const map = new Map<string, ScrapedRow>();
  for (const row of allRows) {
    const code = row["编号"]?.trim();
    if (!code) continue;
    map.set(code, row); // 同编号后出现的覆盖前面的，理论上不应该出现，兜底而已
  }
  return Array.from(map.values());
}

// 去掉查询字符串和结尾斜杠再比较，容忍页面自己在 URL 后面附加的无关参数/尾部斜杠差异，
// 但仍能识别出"跑到了完全不同的地址"（比如登录跳转异常、网站改版换了路径）
function normalizeUrl(url: string): string {
  return url.split("?")[0].replace(/\/+$/, "");
}

// shouldCancel：翻页前回调一次，返回 true 表示任务已被手动终止。
// 终止时直接抛错而不是返回半份数据——半份数据落库会被当成"当曲云上只有这些工单"
export async function scrapeDangquyunTicketList(
  options: { shouldCancel?: () => boolean } = {}
): Promise<ScrapeResult> {
  const browser = await launchBrowser();
  try {
    const context = await getAuthenticatedContext(browser);
    const page = context.pages()[0] ?? (await context.newPage());

    // 登录/跳转流程走完后，最终停留的地址必须是 .env 里配置的 DANGQUYUN_TARGET_URL——
    // 如果因为登录跳转异常、网站改版换了地址等原因跑到了别的网址，后面抓到的数据大概率
    // 是错的（或者压根不是工单列表），这里直接判定本次抓取无效，不继续处理任何数据
    const expectedUrl = normalizeUrl(config.dangquyun.targetUrl);
    const actualUrl = normalizeUrl(page.url());
    if (actualUrl !== expectedUrl) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      const stamp = Date.now();
      await page.screenshot({ path: path.join(DEBUG_DIR, `${stamp}-wrong-target-url.png`), fullPage: true }).catch(() => {});
      fs.writeFileSync(path.join(DEBUG_DIR, `${stamp}-wrong-target-url.html`), await page.content().catch(() => ""));
      throw new Error(
        `抓取时页面最终停留的地址与配置不符（期望：${expectedUrl}，实际：${actualUrl}），` +
          `可能是登录跳转异常或网站改版，本次抓取判定无效`
      );
    }

    // 很多低代码平台把实际业务内容渲染在 iframe 里，主页面本身可能只是个空壳，
    // 所以要连同页面里所有 iframe 一起找，而不只是主页面
    const targets: Locatable[] = [page, ...page.frames()];

    const scrollStat: ScrollStat = { incomplete: false };
    const firstPage = await waitForFirstPageData(targets, FIRST_PAGE_TIMEOUT_MS, scrollStat);
    if (!firstPage) {
      // 三种常见结构在主页面和所有 iframe 里都没找到：保存现场，方便针对实际页面结构调整选择器
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      const stamp = Date.now();
      await page.screenshot({ path: path.join(DEBUG_DIR, `${stamp}-no-table-found.png`), fullPage: true });
      fs.writeFileSync(path.join(DEBUG_DIR, `${stamp}-no-table-found.html`), await page.content());
      const childFrameCount = page.frames().length - 1;
      for (let i = 1; i < page.frames().length; i++) {
        try {
          fs.writeFileSync(
            path.join(DEBUG_DIR, `${stamp}-no-table-found-childframe${i}.html`),
            await page.frames()[i].content()
          );
        } catch {
          // 跨域 iframe 等场景可能拿不到内容，跳过
        }
      }
      // 把各选择器的命中数打出来，一眼能看出是行、单元格还是表头的选择器失效了，
      // 不用再去 .auth/debug 里手工 grep HTML
      for (const t of targets) {
        const probe = await Promise.all(
          [
            ["新版单元格 [data-gridrowkey]", "[data-gridrowkey]"],
            ["旧版行 [data-row-item]", '[data-row-item="true"]'],
            ["旧版单元格 [data-columnitem]", "[data-columnitem]"],
            ["表头", HEADER_SELECTOR],
            ["原生 table", "table"],
          ].map(async ([label, sel]) => `${label}=${await t.locator(sel).count().catch(() => -1)}`)
        );
        console.warn(`[dangquyun] 选择器命中数：${probe.join("  ")}`);
      }
      console.warn(
        `[dangquyun] 未能用通用规则识别出表格结构（${childFrameCount > 0 ? `含 ${childFrameCount} 个子 iframe` : "页面本身没有子 iframe"}），` +
          `已保存截图/HTML 到 backend/.auth/debug/${stamp}-no-table-found.*，请把这些文件发回来，我再针对实际页面结构调整抓取选择器。`
      );
      return { rows: [], strategy: "none", pageCount: 0, scrollIncomplete: scrollStat.incomplete };
    }

    const allRows: ScrapedRow[] = [...firstPage.rows];
    let pageCount = 1;

    while (pageCount < MAX_PAGES) {
      if (options.shouldCancel?.()) throw new Error("任务被手动终止");
      const moved = await goToNextPage(targets);
      if (!moved) break;

      const next = await waitForFirstPageData(targets, PAGINATION_TIMEOUT_MS, scrollStat);
      if (!next || next.rows.length === 0) break; // 翻页后抓不到数据了，停止，避免死循环
      allRows.push(...next.rows);
      pageCount += 1;
    }

    if (pageCount >= MAX_PAGES) {
      console.warn(`[dangquyun] 翻页已达到安全上限 ${MAX_PAGES} 页，提前停止（可能实际页数更多）`);
    }

    return {
      rows: dedupeByCode(allRows),
      strategy: firstPage.strategy,
      pageCount,
      scrollIncomplete: scrollStat.incomplete,
    };
  } finally {
    await browser.close();
  }
}
