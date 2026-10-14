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

/** 从页面上采到的单元格（见 harvestVirtualGrid） */
export interface GridCell {
  rowKey: string;
  nodeId: string;
  /** 列的画布横坐标：已经把横向滚动和左侧冻结列的差异抹平，同一列跨屏采到的值相同 */
  left: number;
  /** 行的画布纵坐标：已经把纵向滚动抹平，只用来决定行与行之间的先后顺序 */
  top: number;
  text: string;
}

/** 表头文字及其所在列。key 取表头上的 data-nodeid/_nk，用来跟单元格的 data-nodeid 对齐 */
export interface GridHeader {
  key: string;
  left: number;
  text: string;
}

/**
 * 把扁平的单元格还原成行：按 rowKey 分组、行间按 top 排序、行内按 left 排成列，再跟表头对齐。
 * 列名优先按列 id（单元格 data-nodeid ↔ 表头 data-nodeid/_nk）匹配，匹配不上再按横坐标就近匹配；
 * 都对不上才退化成占位列名。占位名用横坐标而不是序号，避免某一列没采到时后面所有列名整体错位。
 * 抽成纯函数是为了不起浏览器也能验证这段最容易出错的逻辑。
 */
export function buildRowsFromGridCells(
  cells: GridCell[],
  headers: GridHeader[]
): { rows: ScrapedRow[]; headerMismatch: number } {
  const headerByKey = new Map<string, string>();
  for (const h of headers) {
    if (h.key && h.text) headerByKey.set(h.key, h.text);
  }
  const positioned = headers.filter((h) => h.text);

  // 就近匹配的容差：同一列的表头与单元格左边缘理论上完全对齐，留几像素容忍亚像素误差；
  // 放太宽会把相邻列错配成同一个表头
  const X_TOLERANCE = 6;
  const headerFor = (cell: GridCell): string | null => {
    const byKey = cell.nodeId ? headerByKey.get(cell.nodeId) : undefined;
    if (byKey) return byKey;
    let best: GridHeader | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const h of positioned) {
      const distance = Math.abs(h.left - cell.left);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = h;
      }
    }
    return best && bestDistance <= X_TOLERANCE ? best.text : null;
  };

  const byRow = new Map<string, GridCell[]>();
  for (const cell of cells) {
    if (!cell.rowKey || isUiOnlyColumn(cell.nodeId)) continue;
    const list = byRow.get(cell.rowKey);
    if (list) list.push(cell);
    else byRow.set(cell.rowKey, [cell]);
  }

  const dataHeaderCount = headers.filter((h) => h.text && !isUiOnlyColumn(h.key)).length;
  const rows: ScrapedRow[] = [];
  let headerMismatch = 0;
  // 行间顺序按 top；同一行的单元格 top 相同，取第一个即可
  const ordered = Array.from(byRow.values()).sort((a, b) => a[0].top - b[0].top);
  for (const rowCells of ordered) {
    // 同一列可能在横向滚动的重叠区被采到两次，按列 id 去重保证一列只取一个单元格。
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
    if (dataHeaderCount > 0 && sorted.length !== dataHeaderCount) headerMismatch += 1;

    const row: ScrapedRow = {};
    for (const cell of sorted) {
      row[headerFor(cell) ?? `col@${Math.round(cell.left)}`] = cell.text;
    }
    rows.push(row);
  }
  return { rows, headerMismatch };
}

// 采集一屏后等待下一屏渲染出来的时间。虚拟网格是同步渲染的，不需要等接口，
// 给一帧多一点即可；太长会让 12 页 × 几十屏的总耗时迅速膨胀
const GRID_SETTLE_MS = 150;
// 单页采集的总时间上限，防止滚动条因为页面异常一直滚不到底时无限循环
const GRID_HARVEST_TIMEOUT_MS = 120000;

/** harvestVirtualGrid 的返回值 */
interface HarvestResult {
  cells: GridCell[];
  headers: GridHeader[];
  /** 纵向是不是真的滚到了底。false 表示本页可能没采全 */
  reachedBottom: boolean;
  /** 采集方式的自检信息，采不全时用来定位是哪一环没生效 */
  diagnostics: {
    vScroller: string;
    hScroller: string;
    scrollMode: string;
    columnIdUsable: boolean;
  };
}

/**
 * 当曲云新版表格（lumi 虚拟网格）：DOM 里**没有行元素**，每个单元格都是扁平的绝对定位 div，
 * 靠属性标明归属：
 *   data-gridrowkey="<行id>"   同一行的单元格共用
 *   data-nodeid="<列id>"       列标识；勾选列是 lumi_table_selection_key
 *
 * 关键是它**双向虚拟化**：一页 200 条但同一时刻只渲染视口内的十几行，25 列也只渲染可视的
 * 七八列，滚过去的行/列会被直接从 DOM 里回收。所以「先滚到底、再统一抓一次」是抓不全的——
 * 滚到底时顶部的行早被回收，DOM 里永远只有十几行十几列（这正是之前每页只抓到 14 行、
 * 导致「配置的校验工单编号未出现在抓取结果里」误报的原因）。
 *
 * 这里改成**边滚边采**：横向逐屏滚过去，每个横向位置再纵向逐屏滚到底，每滚一屏就把当前
 * 渲染出来的单元格并进累加表，按 (行id, 列id) 去重。整段放在页面里跑：一页 200×25 = 5000
 * 个单元格，逐个 locator 往返会非常慢。
 */
async function harvestVirtualGrid(
  target: Locatable,
  cellSelector: string
): Promise<HarvestResult | null> {
  return target.evaluate(
    async ({ cellSelector, headerSelector, settleMs, timeoutMs }) => {
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + timeoutMs;

      // 往上找真正能滚动的祖先元素。先认 overflow 是 auto/scroll 的，
      // 找不到再退一步认"内容比可视区大"的——有的虚拟表格外层写的是 overflow:hidden
      const findScroller = (start: Element | null, axis: "x" | "y"): HTMLElement | null => {
        let fallback: HTMLElement | null = null;
        let el = start as HTMLElement | null;
        while (el && el !== document.body) {
          const style = getComputedStyle(el);
          const overflow = axis === "y" ? style.overflowY : style.overflowX;
          const overflowing =
            axis === "y"
              ? el.scrollHeight > el.clientHeight + 4
              : el.scrollWidth > el.clientWidth + 4;
          if (overflowing) {
            if (overflow === "auto" || overflow === "scroll") return el;
            if (!fallback) fallback = el;
          }
          el = el.parentElement;
        }
        return fallback;
      };

      const firstCell = document.querySelector(cellSelector);
      if (!firstCell) return null;
      const vScroller = findScroller(firstCell, "y");
      const hScroller = findScroller(firstCell, "x");
      // 外层 overflow:hidden、靠监听 wheel 自己平移内容的表格，设 scrollTop 是推不动的，
      // 得往元素上派发 wheel 事件。用哪种方式不预先判断，实际试一次看推没推动
      const wheelTarget = ((firstCell as HTMLElement).parentElement ?? document.body) as HTMLElement;
      const mode: { x: "scroll" | "wheel" | null; y: "scroll" | "wheel" | null } = { x: null, y: null };

      // 冻结列不随横向滚动移动，它的屏幕坐标本身就是稳定的列坐标；普通列的屏幕坐标会随
      // scrollLeft 变，要加回 scrollLeft 才能跨屏对齐成同一个值。哪些是冻结列不靠 class 猜，
      // 靠实测：同一列在两个不同 scrollLeft 下屏幕坐标没变的就是。冻结与否要等整轮采完才能
      // 判定，所以这里只记录原始样本，最后再统一换算
      interface XSample {
        minScrollLeft: number;
        xAtMin: number;
        maxScrollLeft: number;
        xAtMax: number;
      }
      const sampleX = (store: Map<string, XSample>, key: string, x: number, scrollLeft: number) => {
        const prev = store.get(key);
        if (!prev) {
          store.set(key, { minScrollLeft: scrollLeft, xAtMin: x, maxScrollLeft: scrollLeft, xAtMax: x });
          return;
        }
        if (scrollLeft < prev.minScrollLeft) {
          prev.minScrollLeft = scrollLeft;
          prev.xAtMin = x;
        }
        if (scrollLeft > prev.maxScrollLeft) {
          prev.maxScrollLeft = scrollLeft;
          prev.xAtMax = x;
        }
      };
      const resolveX = (sample: XSample | undefined): number => {
        if (!sample) return 0;
        const moved = sample.maxScrollLeft > sample.minScrollLeft;
        const frozen = moved && Math.abs(sample.xAtMax - sample.xAtMin) < 2;
        return frozen ? sample.xAtMin : sample.xAtMin + sample.minScrollLeft;
      };

      // 列 id 只从表头元素自身或它最近的表头容器上取。不能顺着祖先一路往上找——
      // 再往上就是整个表头行的公共容器，25 个表头会全部拿到同一个 id collapse 成一列
      const columnIdOf = (el: Element): string => {
        const wrapper = el.closest('[class*="columnItemHeaderTitle"]');
        for (const node of [el, wrapper]) {
          if (!node) continue;
          const value = node.getAttribute("data-nodeid") || node.getAttribute("_nk");
          if (value) return value;
        }
        return "";
      };

      const cellX = new Map<string, XSample>();
      const headerX = new Map<string, XSample>();
      const cellData = new Map<string, { rowKey: string; colKey: string; nodeId: string; top: number; text: string }>();
      // 表头按文字去重：文字天然一列一个，比列 id 稳妥
      const headerColumnId = new Map<string, string>();

      const snapshot = () => {
        const scrollLeft = hScroller ? hScroller.scrollLeft : 0;
        const scrollTop = vScroller ? vScroller.scrollTop : 0;

        document.querySelectorAll(cellSelector).forEach((node) => {
          const el = node as HTMLElement;
          const rowKey = el.getAttribute("data-gridrowkey") ?? "";
          if (!rowKey) return;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return;
          const nodeId = el.getAttribute("data-nodeid") ?? "";
          const colKey = nodeId || `x${Math.round(rect.left + scrollLeft)}`;
          sampleX(cellX, colKey, rect.left, scrollLeft);
          const text = (el.innerText || el.textContent || "").trim();
          const key = `${rowKey}\u0000${colKey}`;
          const prev = cellData.get(key);
          // 同一个单元格会在横向/纵向重叠区被采到多次：已经采到过文字就别被渲染中途的空白覆盖
          if (prev && !text) return;
          cellData.set(key, { rowKey, colKey, nodeId, top: rect.top + scrollTop, text });
        });

        document.querySelectorAll(headerSelector).forEach((node) => {
          const el = node as HTMLElement;
          const text = (el.innerText || el.textContent || "").trim();
          if (!text) return;
          const rect = (el.closest('[class*="columnItemHeaderTitle"]') ?? el).getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return;
          sampleX(headerX, text, rect.left, scrollLeft);
          if (!headerColumnId.get(text)) headerColumnId.set(text, columnIdOf(el));
        });
      };

      const posOf = (axis: "x" | "y"): number => {
        const scroller = axis === "y" ? vScroller : hScroller;
        if (!scroller) return 0;
        return axis === "y" ? scroller.scrollTop : scroller.scrollLeft;
      };

      // 往某个方向推一屏。先试 scrollTop/scrollLeft，推不动再派发 wheel；
      // 哪种有效记在 mode 里，后面直接用，不再每次都试
      const advance = async (axis: "x" | "y", amount: number) => {
        const scroller = axis === "y" ? vScroller : hScroller;
        if (scroller && mode[axis] !== "wheel") {
          const before = posOf(axis);
          if (axis === "y") scroller.scrollTop = before + amount;
          else scroller.scrollLeft = before + amount;
          await sleep(settleMs);
          if (posOf(axis) !== before) {
            mode[axis] = "scroll";
            snapshot();
            return;
          }
        }
        wheelTarget.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: axis === "y" ? amount : 0,
            deltaX: axis === "x" ? amount : 0,
            bubbles: true,
            cancelable: true,
          })
        );
        if (mode[axis] !== "scroll") mode[axis] = "wheel";
        await sleep(settleMs);
        snapshot();
      };

      // 回到起点。wheel 模式下没有可写的 scrollTop，只能反向多推几把
      const resetAxis = async (axis: "x" | "y") => {
        const scroller = axis === "y" ? vScroller : hScroller;
        if (scroller) {
          if (axis === "y") scroller.scrollTop = 0;
          else scroller.scrollLeft = 0;
        }
        if (mode[axis] === "wheel") {
          for (let i = 0; i < 40; i++) {
            wheelTarget.dispatchEvent(
              new WheelEvent("wheel", {
                deltaY: axis === "y" ? -2000 : 0,
                deltaX: axis === "x" ? -2000 : 0,
                bubbles: true,
                cancelable: true,
              })
            );
          }
        }
        await sleep(settleMs);
      };

      // 采集是"推进式"而不是"按滚动条几何算步数"的：每推一屏看累加表有没有长出新东西，
      // 连续几屏没有新内容才算到头。这样不管表格是真滚动条还是 wheel 平移都能收敛
      const vStep = () => (vScroller ? Math.max(40, vScroller.clientHeight - 80) : 400);
      const hStep = () => (hScroller ? Math.max(80, hScroller.clientWidth - 80) : 400);

      let reachedBottom = true;
      await resetAxis("x");
      for (let hRound = 0; hRound < 40; hRound++) {
        await resetAxis("y");
        snapshot();

        let settled = false;
        let stagnant = 0;
        for (let guard = 0; guard < 400; guard++) {
          if (Date.now() > deadline) break;
          const before = cellData.size;
          await advance("y", vStep());
          if (cellData.size === before) {
            stagnant += 1;
            if (stagnant >= 3) {
              settled = true;
              break;
            }
          } else {
            stagnant = 0;
          }
        }
        if (!settled) reachedBottom = false;

        if (Date.now() > deadline) break;
        // 横向到头了就结束；推一屏还没发现新列也结束
        if (hScroller && mode.x !== "wheel" && hScroller.scrollLeft + hScroller.clientWidth >= hScroller.scrollWidth - 2) break;
        const beforeColumns = cellX.size;
        await advance("x", hStep());
        if (cellX.size === beforeColumns) break;
      }

      const cells = Array.from(cellData.values()).map((c) => ({
        rowKey: c.rowKey,
        nodeId: c.nodeId,
        left: resolveX(cellX.get(c.colKey)),
        top: c.top,
        text: c.text,
      }));
      // 列 id 只有在"每个表头各不相同"时才可信。取不到（或取到的是公共容器 id，
      // 25 个表头全一样）就整体弃用，退回按横坐标对齐
      const ids = Array.from(headerColumnId.values());
      const idsUsable = ids.every((v) => v) && new Set(ids).size === ids.length;
      const headers = Array.from(headerColumnId.entries()).map(([text, id]) => ({
        key: idsUsable ? id : "",
        left: resolveX(headerX.get(text)),
        text,
      }));
      return {
        cells,
        headers,
        reachedBottom,
        diagnostics: {
          vScroller: vScroller ? `${vScroller.className || vScroller.tagName}` : "未找到",
          hScroller: hScroller ? `${hScroller.className || hScroller.tagName}` : "未找到",
          scrollMode: `纵向=${mode.y ?? "未动"} 横向=${mode.x ?? "未动"}`,
          columnIdUsable: idsUsable,
        },
      };
    },
    { cellSelector, headerSelector: HEADER_SELECTOR, settleMs: GRID_SETTLE_MS, timeoutMs: GRID_HARVEST_TIMEOUT_MS }
  );
}

async function extractFromVirtualGrid(
  target: Locatable,
  stat?: ScrollStat
): Promise<ScrapedRow[] | null> {
  const cellSelector = "[data-gridrowkey]";
  if ((await target.locator(cellSelector).count()) === 0) return null;

  const harvested = await harvestVirtualGrid(target, cellSelector);
  if (!harvested || harvested.cells.length === 0) return null;

  if (!harvested.reachedBottom && stat) {
    stat.incomplete = true;
    console.warn(
      `[dangquyun] 本页滚动采集超时，已采到 ${harvested.cells.length} 个单元格但未滚到底，本次抓取结果可能不完整`
    );
  }

  const { rows, headerMismatch } = buildRowsFromGridCells(harvested.cells, harvested.headers);
  if (rows.length === 0) return null;

  if (headerMismatch > 0) {
    // 列数对不上时可能有字段没采到，必须说清楚，否则会悄悄落一批列名是 col@123 的脏数据
    console.warn(
      `[dangquyun] 有 ${headerMismatch}/${rows.length} 行的列数与表头数（${harvested.headers.length}）不一致，` +
        "对不上表头的列会退化成 col@横坐标 这类占位列名"
    );
  }
  console.log(
    `[dangquyun] 本页采集完成：${rows.length} 行 × ${harvested.headers.length} 列表头` +
      `（滚动容器 纵=${harvested.diagnostics.vScroller} 横=${harvested.diagnostics.hScroller}；` +
      `${harvested.diagnostics.scrollMode}；列id可用=${harvested.diagnostics.columnIdUsable}）`
  );
  return rows;
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

/**
 * 接口探针：把页面发出的 JSON 响应按"体积从大到小"汇总打印。
 * 工单列表那个接口的响应体通常是整页里最大的几个之一，据此一眼就能认出来。
 * 只在 DANGQUYUN_DEBUG=true 时挂载，正式跑不受影响。
 */
function attachApiProbe(page: Page): void {
  const seen: { url: string; size: number; status: number }[] = [];
  page.on("response", (res) => {
    const type = res.headers()["content-type"] ?? "";
    if (!type.includes("json")) return;
    // 不读 body 本身，只量体积：读 body 会消耗响应流，可能影响页面自身的解析
    res
      .body()
      .then((buf) => {
        seen.push({ url: res.url(), size: buf.length, status: res.status() });
      })
      .catch(() => {});
  });
  page.on("close", () => printApiProbe(seen));
  // 页面不一定触发 close（流程里是直接 browser.close()），所以也挂到进程退出
  process.once("beforeExit", () => printApiProbe(seen));
}

// 接口探针认出来的工单列表接口（当曲云用聚合 GraphQL 网关，一页一次请求，响应 1MB 上下）
const LIST_API_PATTERN = /\/aggregatedata\/GraphQL\/page\/execute/i;

/**
 * DEBUG 模式下把列表接口的响应存盘并打印结构摘要。
 * DOM 那条路要跟双向虚拟化死磕，接口返回的却是整页全量行全量字段——
 * 摸清结构之后直接截获接口就能一步到位，这里先把结构摸出来。
 */
function attachListApiDump(page: Page): void {
  let index = 0;
  page.on("response", (res) => {
    if (!LIST_API_PATTERN.test(res.url())) return;
    if (!(res.headers()["content-type"] ?? "").includes("json")) return;
    const seq = ++index;
    if (seq > 2) return; // 存两份足够看结构，存多了白白占磁盘
    res
      .text()
      .then((body) => {
        fs.mkdirSync(DEBUG_DIR, { recursive: true });
        const file = path.join(DEBUG_DIR, `${Date.now()}-list-api-${seq}.json`);
        fs.writeFileSync(file, body);
        console.log(`[dangquyun][列表接口] 第 ${seq} 份响应已存到 ${file}`);
        try {
          describeListApi(JSON.parse(body));
        } catch {
          console.log("[dangquyun][列表接口] 响应不是合法 JSON，跳过结构分析");
        }
      })
      .catch(() => {});
  });
}

/** 在任意深度的 JSON 里找出"最长的那个对象数组"，工单列表几乎必然是它 */
function findLargestObjectArray(root: unknown): { path: string; items: Record<string, unknown>[] } | null {
  let best: { path: string; items: Record<string, unknown>[] } | null = null;
  const walk = (node: unknown, nodePath: string, depth: number) => {
    if (depth > 8 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      const objects = node.filter(
        (v) => v !== null && typeof v === "object" && !Array.isArray(v)
      ) as Record<string, unknown>[];
      if (objects.length > 0 && (!best || objects.length > best.items.length)) {
        best = { path: nodePath, items: objects };
      }
      // 只往前几个元素里钻，同构数组看一个就够，否则深层嵌套的大响应会扫很久
      node.slice(0, 3).forEach((v, i) => walk(v, `${nodePath}[${i}]`, depth + 1));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      walk(value, nodePath ? `${nodePath}.${key}` : key, depth + 1);
    }
  };
  walk(root, "", 0);
  return best;
}

/** 打印列表接口的结构摘要：数组在哪、多少条、单条有哪些字段。值一律截断，避免刷屏 */
function describeListApi(parsed: unknown): void {
  const found = findLargestObjectArray(parsed);
  if (!found) {
    console.log("[dangquyun][列表接口] 响应里没找到对象数组，结构可能不是预期的那种");
    return;
  }
  console.log(
    `[dangquyun][列表接口] 最大的对象数组在 ${found.path || "<根>"}，共 ${found.items.length} 条记录`
  );
  const keys = Object.keys(found.items[0]);
  console.log(`[dangquyun][列表接口] 单条记录 ${keys.length} 个字段：`);
  for (const key of keys.slice(0, 50)) {
    const value = found.items[0][key];
    const preview =
      value === null || value === undefined
        ? String(value)
        : typeof value === "object"
          ? `${Array.isArray(value) ? "数组" : "对象"} ${JSON.stringify(value).slice(0, 50)}…`
          : String(value).slice(0, 24);
    console.log(`    ${key} = ${preview}`);
  }
  if (keys.length > 50) console.log(`    …另有 ${keys.length - 50} 个字段未列出`);
}

let apiProbePrinted = false;
function printApiProbe(seen: { url: string; size: number; status: number }[]): void {
  if (apiProbePrinted || seen.length === 0) return;
  apiProbePrinted = true;
  const top = [...seen].sort((a, b) => b.size - a.size).slice(0, 12);
  console.log(`[dangquyun][接口探针] 共捕获 ${seen.length} 个 JSON 响应，按体积排序取前 ${top.length} 个：`);
  top.forEach((r, i) => {
    // URL 可能很长且带 token，截断到 160 字符
    const url = r.url.length > 160 ? `${r.url.slice(0, 160)}…` : r.url;
    console.log(`  ${String(i + 1).padStart(2)}. ${(r.size / 1024).toFixed(1).padStart(8)} KB  [${r.status}]  ${url}`);
  });
  console.log("[dangquyun][接口探针] 体积最大的那个多半就是工单列表接口，把这份清单发回来即可");
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

    // DEBUG 模式下记录页面发出的所有 JSON 接口响应，用来定位"工单列表数据是哪个接口返回的"。
    // 找到之后就能直接截获接口 JSON，不必再跟虚拟网格的横向/纵向虚拟化较劲——
    // DOM 里一次只渲染 14/200 行、9/25 列，而接口返回的是全量行与全量字段
    if (config.dangquyun.debug) {
      attachApiProbe(page);
      attachListApiDump(page);
    }

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
