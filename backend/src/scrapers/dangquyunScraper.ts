import fs from "fs";
import path from "path";
import { Frame, Page } from "playwright";
import { getAuthenticatedContext, launchBrowser } from "./dangquyunAuth";

const DEBUG_DIR = path.join(__dirname, "../../.auth/debug");
const MAX_PAGES = 60; // 安全上限，防止分页逻辑出问题时无限翻页

export interface ScrapedRow {
  [columnHeader: string]: string;
}

export type ExtractStrategy = "dangqu-grid" | "native-table" | "aria-grid";

export interface ScrapeResult {
  rows: ScrapedRow[];
  strategy: ExtractStrategy | "none";
  pageCount: number;
}

type Locatable = Page | Frame;

// 首屏冷启动超时（微前端首次加载几十个远程 chunk，观察到偏慢，放宽到 4 分钟）
const FIRST_PAGE_TIMEOUT_MS = 240000;
// 翻页超时：应用已经加载完成，翻页只是同一个已挂载模块内部重新请求/渲染数据，
// 不需要再等首屏那么久；等太久反而会让"获取新工单"这个同步 HTTP 请求整体超时更容易被
// 客户端提前放弃，与并发锁互相踩踏，所以单独给一个短得多的超时
const PAGINATION_TIMEOUT_MS = 30000;

// 当曲云是微前端架构（主壳先渲染出来，工单列表本身由独立的远程模块异步加载挂载进来），
// 首屏渲染出来时列表模块可能压根还没开始渲染，此时既没有文字也没有 antd 的加载中转圈（class
// 带 spin-spinning），"没转圈=已加载完成"的判断会误判。所以不区分"等转圈消失"和"抓取"两步，
// 而是直接反复尝试抓取，抓到数据或者彻底超时才停止
async function waitForFirstPageData(
  targets: Locatable[],
  timeoutMs: number
): Promise<{ rows: ScrapedRow[]; strategy: ExtractStrategy } | null> {
  const deadline = Date.now() + timeoutMs;
  let lastAttempt: { rows: ScrapedRow[]; strategy: ExtractStrategy } | null = null;
  while (Date.now() < deadline) {
    lastAttempt = await extractCurrentPage(targets);
    if (lastAttempt) return lastAttempt;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return lastAttempt;
}

// 当曲云（lumi 自研表格组件）的实际结构：既不是原生 table，也没有标准 ARIA role，
// 而是每一行用 data-row-item="true" 标记、每个单元格用 data-columnitem 标记；
// class 名带编译哈希（如 columnItemHeaderTitle___3CMa-）会变，属性选择器更稳定
async function extractFromDangquyunGrid(target: Locatable): Promise<ScrapedRow[] | null> {
  const rowLocator = target.locator('[data-row-item="true"]');
  const rowCount = await rowLocator.count();
  if (rowCount === 0) return null;

  const headers = await target.locator('[class*="columnItemHeaderTitle"] [class*="titleSpanTitle"]').allTextContents();

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
  targets: Locatable[]
): Promise<{ rows: ScrapedRow[]; strategy: ExtractStrategy } | null> {
  for (const target of targets) {
    const rows = await extractFromDangquyunGrid(target).catch(() => null);
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

export async function scrapeDangquyunTicketList(): Promise<ScrapeResult> {
  const browser = await launchBrowser();
  try {
    const context = await getAuthenticatedContext(browser);
    const page = context.pages()[0] ?? (await context.newPage());

    // 很多低代码平台把实际业务内容渲染在 iframe 里，主页面本身可能只是个空壳，
    // 所以要连同页面里所有 iframe 一起找，而不只是主页面
    const targets: Locatable[] = [page, ...page.frames()];

    const firstPage = await waitForFirstPageData(targets, FIRST_PAGE_TIMEOUT_MS);
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
      console.warn(
        `[dangquyun] 未能用通用规则识别出表格结构（${childFrameCount > 0 ? `含 ${childFrameCount} 个子 iframe` : "页面本身没有子 iframe"}），` +
          `已保存截图/HTML 到 backend/.auth/debug/${stamp}-no-table-found.*，请把这些文件发回来，我再针对实际页面结构调整抓取选择器。`
      );
      return { rows: [], strategy: "none", pageCount: 0 };
    }

    const allRows: ScrapedRow[] = [...firstPage.rows];
    let pageCount = 1;

    while (pageCount < MAX_PAGES) {
      const moved = await goToNextPage(targets);
      if (!moved) break;

      const next = await waitForFirstPageData(targets, PAGINATION_TIMEOUT_MS);
      if (!next || next.rows.length === 0) break; // 翻页后抓不到数据了，停止，避免死循环
      allRows.push(...next.rows);
      pageCount += 1;
    }

    if (pageCount >= MAX_PAGES) {
      console.warn(`[dangquyun] 翻页已达到安全上限 ${MAX_PAGES} 页，提前停止（可能实际页数更多）`);
    }

    return { rows: dedupeByCode(allRows), strategy: firstPage.strategy, pageCount };
  } finally {
    await browser.close();
  }
}
