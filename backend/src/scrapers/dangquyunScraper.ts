import fs from "fs";
import path from "path";
import { Page } from "playwright";
import { config } from "../config";
import { getAuthenticatedContext, launchBrowser } from "./dangquyunAuth";

const DEBUG_DIR = path.join(__dirname, "../../.auth/debug");

export interface ScrapedRow {
  [columnHeader: string]: string;
}

export interface ScrapeResult {
  rows: ScrapedRow[];
  strategy: "native-table" | "aria-grid" | "none";
}

// 原生 <table> 结构提取
async function extractFromNativeTable(page: Page): Promise<ScrapedRow[] | null> {
  const table = page.locator("table").first();
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
async function extractFromAriaGrid(page: Page): Promise<ScrapedRow[] | null> {
  const headerCells = page.locator('[role="columnheader"]');
  const headerCount = await headerCells.count();
  if (headerCount === 0) return null;
  const headers = await headerCells.allTextContents();

  const rowLocator = page.locator('[role="row"]');
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

    const nativeRows = await extractFromNativeTable(page);
    if (nativeRows) {
      return { rows: nativeRows, strategy: "native-table" };
    }

    const ariaRows = await extractFromAriaGrid(page);
    if (ariaRows) {
      return { rows: ariaRows, strategy: "aria-grid" };
    }

    // 两种常见结构都没找到数据：保存现场，方便针对实际页面结构调整选择器
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = Date.now();
    await page.screenshot({ path: path.join(DEBUG_DIR, `${stamp}-no-table-found.png`), fullPage: true });
    fs.writeFileSync(path.join(DEBUG_DIR, `${stamp}-no-table-found.html`), await page.content());
    console.warn(
      `[dangquyun] 未能用通用规则识别出表格结构，已保存截图/HTML 到 backend/.auth/debug/${stamp}-no-table-found.*，` +
        "请把这两个文件发回来，我再针对实际页面结构调整抓取选择器。"
    );
    return { rows: [], strategy: "none" };
  } finally {
    await browser.close();
  }
}
