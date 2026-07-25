import fs from "fs";
import path from "path";
import { Frame, Page } from "playwright";
import { getAuthenticatedContext, launchBrowser } from "./dangquyunAuth";

const DEBUG_DIR = path.join(__dirname, "../../.auth/debug");

export interface ScrapedRow {
  [columnHeader: string]: string;
}

export interface ScrapeResult {
  rows: ScrapedRow[];
  strategy: "dangqu-grid" | "native-table" | "aria-grid" | "none";
}

type Locatable = Page | Frame;

// 当曲云基于 antd 组件库，表格数据是异步加载的：外壳（左侧菜单、顶部标签）先渲染出来，
// 真正的工单列表在请求完成前会一直显示 antd 的加载中转圈（class 带 spin-spinning），
// 不能只看页面有没有文字（菜单文字一直都在），要专门等这个转圈状态消失
async function waitForSpinnersToFinish(targets: Locatable[], timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let anySpinning = false;
    for (const target of targets) {
      const count = await target
        .locator('[class*="spin-spinning"]')
        .count()
        .catch(() => 0);
      if (count > 0) {
        anySpinning = true;
        break;
      }
    }
    if (!anySpinning) return;
    await new Promise((r) => setTimeout(r, 800));
  }
  console.warn("[dangquyun] 等待加载中转圈消失超时，仍尝试继续抓取（可能数据本来就没加载出来）");
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

export async function scrapeDangquyunTicketList(): Promise<ScrapeResult> {
  const browser = await launchBrowser();
  try {
    const context = await getAuthenticatedContext(browser);
    const page = context.pages()[0] ?? (await context.newPage());

    // 很多低代码平台把实际业务内容渲染在 iframe 里，主页面本身可能只是个空壳，
    // 所以要连同页面里所有 iframe 一起找，而不只是主页面
    const targets: Locatable[] = [page, ...page.frames()];

    await waitForSpinnersToFinish(targets);

    for (const target of targets) {
      const dangquyunRows = await extractFromDangquyunGrid(target).catch(() => null);
      if (dangquyunRows) {
        return { rows: dangquyunRows, strategy: "dangqu-grid" };
      }
    }

    for (const target of targets) {
      const nativeRows = await extractFromNativeTable(target).catch(() => null);
      if (nativeRows) {
        return { rows: nativeRows, strategy: "native-table" };
      }
    }

    for (const target of targets) {
      const ariaRows = await extractFromAriaGrid(target).catch(() => null);
      if (ariaRows) {
        return { rows: ariaRows, strategy: "aria-grid" };
      }
    }

    // 两种常见结构在主页面和所有 iframe 里都没找到：保存现场，方便针对实际页面结构调整选择器
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = Date.now();
    await page.screenshot({ path: path.join(DEBUG_DIR, `${stamp}-no-table-found.png`), fullPage: true });
    fs.writeFileSync(path.join(DEBUG_DIR, `${stamp}-no-table-found.html`), await page.content());
    // page.frames() 第一个是主页面本身，从第二个开始才是真正嵌套的子 iframe
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
    return { rows: [], strategy: "none" };
  } finally {
    await browser.close();
  }
}
