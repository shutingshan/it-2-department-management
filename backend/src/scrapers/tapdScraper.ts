/**
 * TAPD 需求详情页字段抓取。
 *
 * 选择器为通用策略实现（按字段中文标签查找相邻的值），未经真实 tapd.cn 页面结构验证——
 * 跟当曲云抓取器一样，第一次真实跑起来大概率需要根据实际页面 HTML 调整。跑的时候把
 * TAPD_DEBUG=true 打开，失败截图/HTML 会存到 backend/.auth/debug/，发回来我再调整。
 *
 * 迭代、月度计划、子需求列表暂未接入真实抓取（迭代需要可靠的起止日期、子需求列表结构
 * 差异较大，贸然猜测容易产出错误数据），先只处理字段值相对简单直接的部分：
 * TAPD状态、预估工时、完成工时、开发人员、处理人。
 */
import fs from "fs";
import path from "path";
import { Frame, Page } from "playwright";
import { config } from "../config";
import { getTapdAuthenticatedContext, isWafBlocked, launchTapdBrowser } from "./tapdAuth";
import { TapdStoryFields, TapdSubStoryFields } from "./tapdApi";

const DEBUG_DIR = path.join(__dirname, "../../.auth/debug");

type Locatable = Page | Frame;

async function dumpDebug(page: Page, label: string) {
  if (!config.tapd.debug) return;
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = Date.now();
    await page.screenshot({ path: path.join(DEBUG_DIR, `${stamp}-tapd-story-${label}.png`), fullPage: true });
    fs.writeFileSync(path.join(DEBUG_DIR, `${stamp}-tapd-story-${label}.html`), await page.content());
  } catch (e) {
    console.warn(`[tapd] 保存需求详情页调试信息失败（${label}）`, (e as Error).message);
  }
}

async function getFieldValueByLabel(target: Locatable, label: string): Promise<string | null> {
  return target
    .evaluate((labelText) => {
      function norm(s: string | null) {
        return (s ?? "").replace(/[:：\s]+$/, "").trim();
      }
      const candidates = Array.from(document.querySelectorAll("body *")).filter(
        (el) => el.children.length === 0
      );
      for (const el of candidates) {
        if (norm(el.textContent) !== labelText) continue;

        // 策略1：dt -> dd
        if (el.tagName === "DT" && el.nextElementSibling?.tagName === "DD") {
          return (el.nextElementSibling.textContent ?? "").trim();
        }
        // 策略2：表格 th/td(标签) -> 同行下一个单元格
        if ((el.tagName === "TH" || el.tagName === "TD") && el.parentElement) {
          const cells = Array.from(el.parentElement.children);
          const idx = cells.indexOf(el);
          if (idx >= 0 && cells[idx + 1]) return (cells[idx + 1].textContent ?? "").trim();
        }
        // 策略3：紧邻的下一个兄弟节点
        if (el.nextElementSibling) {
          return (el.nextElementSibling.textContent ?? "").trim();
        }
        // 策略4：父容器里标签是第一个子节点，值是第二个
        const parent = el.parentElement;
        if (parent && parent.children.length >= 2 && parent.children[0] === el) {
          return (parent.children[1].textContent ?? "").trim();
        }
      }
      return null;
    }, label)
    .catch(() => null);
}

function parseHours(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && v.trim() !== "" ? n : null;
}

function parseNameList(v: string | null): string[] {
  if (!v) return [];
  return Array.from(new Set(v.split(/[、,，;；\s]+/).map((s) => s.trim()).filter(Boolean)));
}

// 字段结构与 API 模式共用同一份定义（tapdApi.ts），保证两种取数方式对上层完全等价
export type { TapdStoryFields, TapdSubStoryFields } from "./tapdApi";

// TAPD 需求详情页数据多为异步加载，页面骨架可能先于实际字段渲染出来（实测首次渲染可能较慢，
// 跟当曲云类似）；最多等 10 分钟让内容真正加载完，而不是固定睡一小段时间就去抓取
async function waitForContentToLoad(page: Page, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await page.evaluate(() => document.body?.innerText?.trim().length ?? 0);
      if (text > 0) {
        // 页面上出现文字不代表异步数据/后续脚本（含可能的跳转）都跑完了，多等几秒让它彻底稳定，
        // 避免过早去读字段/过早关闭页面时,还有没执行完的逻辑
        await page.waitForTimeout(5000);
        return;
      }
    } catch {
      // 页面这期间又发生了一次内部跳转/刷新，执行上下文失效，当作"还没准备好"继续等
    }
    await page.waitForTimeout(500);
  }
}

// 先在列表页里插入一个真的 <a> 元素，再用 Playwright 的 click（会派发真实的、浏览器
// 认可的"用户点击"事件）去点它触发导航——而不是 page.goto()。用户手动在自己浏览器里粘贴
// 同一个地址是正常的，但我们全新会话里 page.goto() 硬跳转会被重定向回列表页；两者的关键区别
// 之一是 page.goto() 属于脚本发起的导航，浏览器不会把它标记成"真实用户操作"（Chrome 只有
// 真实点击/地址栏回车才会带上这个标记），如果安全网关按这个标记区分"疑似自动化"的深链接访问，
// 模拟一次真实点击就能绕开
async function clickToNavigate(page: Page, url: string) {
  await page.evaluate((href) => {
    document.getElementById("__tapd_auto_nav__")?.remove();
    const a = document.createElement("a");
    a.id = "__tapd_auto_nav__";
    a.href = href;
    // 之前抓到的真实页面 HTML 里，TAPD 自己内部的链接除了普通 href，还带着 fe-link（空属性，
    // 前端路由用来识别"这是一次应用内跳转"）和 link（不带域名的相对路径）这两个属性；
    // 我们插入的这个链接原来只有 href，很可能没被它自己的路由监听逻辑识别成"真的点了内部链接"，
    // 只是当成普通整页跳转处理——补上这两个属性，尽量让它更像一个真的应用内链接
    a.setAttribute("fe-link", "");
    try {
      const parsed = new URL(href);
      a.setAttribute("link", parsed.pathname.replace(/^\/tapd_fe/, ""));
    } catch {
      // ignore
    }
    a.textContent = "auto-nav";
    a.style.position = "fixed";
    // 左上角 (0,0) 那个位置正好是TAPD自己的logo/侧边栏收起按钮所在区域，之前测试发现点在
    // 那里会连带点到TAPD页面自身的导航元素，弹出一堆多余窗口；改到页面正中间、给最高
    // z-index，确保点到的一定是我们自己插入的这个元素，不会被其他真实UI元素挡住或顶替
    a.style.top = "50%";
    a.style.left = "50%";
    a.style.width = "20px";
    a.style.height = "20px";
    a.style.zIndex = "2147483647";
    a.style.background = "#fff";
    document.body.appendChild(a);
  }, url);
  const nav = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 600000 }).catch(() => {});
  await page.click("#__tapd_auto_nav__");
  await nav;
  // 跳转落地后再缓一缓，给页面上可能还在跑的重定向/异步逻辑留出时间，避免立刻接着操作页面
  await page.waitForTimeout(3000);
}

// page 必须是已经从 TAPD 首页/工作台开始、连续导航过来的同一个页面（见 tapdAuth.ts 的
// getTapdAuthenticatedContext），不能每次都另开一个全新页面直接硬跳转到需求详情——
// 实测发现：全新页面无论是 page.goto() 硬跳转还是模拟真实点击，只要没有从首页开始过，
// 都会被应用自己重定向回需求列表页；只有像真实用户那样"先进首页、再一路点过去"，
// 在同一个页面里连续导航，才能真正停留在具体的需求详情上
// 从当曲云同步过来的"关联TAPD"地址，实测发现不止一种格式，比如：
// https://www.tapd.cn/tapd_fe/<空间id>/story/detail/<id>
// https://www.tapd.cn/<空间id>/prong/stories/view/<id>
// 无法针对每种格式各写一套"列表页"推导规则；但不管哪种格式，网址里都带着空间 id
// （第一段纯数字的路径片段），而"需求列表"这个页面固定是 tapd_fe/<空间id>/story/list，
// 所以统一从空间 id 推导出这一个已验证能正常打开的列表页地址做热身，不用管目标详情地址本身是什么格式
function deriveWorkspaceListUrl(tapdUrl: string): string | null {
  const match = tapdUrl.match(/tapd\.cn\/(?:tapd_fe\/)?(\d+)\//);
  if (!match) return null;
  return `https://www.tapd.cn/tapd_fe/${match[1]}/story/list`;
}

// TAPD 详情页右侧字段面板是懒渲染的：靠下的字段（月度计划、完成工时等）不滚动到可视区域
// 就不会出现在 DOM 里。抓取前先把页面上所有可滚动容器都滚到底，逼它把剩下的字段渲染出来
async function scrollAllToBottom(page: Page) {
  await page
    .evaluate(() => {
      const scrollables = Array.from(document.querySelectorAll<HTMLElement>("*")).filter((el) => {
        const style = getComputedStyle(el);
        return (
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight + 10
        );
      });
      for (const el of scrollables) el.scrollTop = el.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    })
    .catch(() => {});
  await page.waitForTimeout(1200);
}

// 按 TAPD 详情页真实结构读取右侧字段面板：每个字段是一个 .entity-detail-right-col 块，
// 里面 __key 是中文标签、__value 里的 span 上有 title 属性存着显示值（空值时为 "-"）。
// 按中文标签取值而不是写死 field 名，是因为"测试人员/月度计划"这类是各空间自定义字段
// （本空间是 custom_field_two / custom_field_seven），换个空间编号就不一样了
async function readRightPanel(page: Page): Promise<Record<string, string>> {
  return page
    .evaluate(() => {
      const map: Record<string, string> = {};
      for (const col of Array.from(document.querySelectorAll(".entity-detail-right-col"))) {
        const label = (col.querySelector(".entity-detail-right-col__key")?.textContent ?? "").trim();
        if (!label) continue;
        const valueEl = col.querySelector(".entity-detail-right-col__value");
        if (!valueEl) continue;
        // 优先取 span 的 title（显示值，迭代这类字段的 value 属性存的是内部id而非名称），
        // 没有 title 就退回文本内容
        const span = valueEl.querySelector("span[title]");
        const raw = (span?.getAttribute("title") ?? valueEl.textContent ?? "").trim();
        // "-" 是 TAPD 表示"该字段没填"的占位符，这里统一归一成空字符串保留下来——
        // 键存在但值为空，代表"页面上确实是空的"，跟"页面上压根没找到这个字段"要区分开
        map[label] = raw === "-" ? "" : raw;
      }
      return map;
    })
    .catch(() => ({}));
}

// 状态不在右侧字段面板里，而是详情页左上角那个下拉按钮（.status-label-button 里的 button，
// 其 title 属性就是当前状态名，如"规划中"）
async function readStatus(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const btn = document.querySelector(".status-label-button button, .status-transfer-wrap button");
      const title = btn?.getAttribute("title")?.trim();
      if (title) return title;
      const text = document.querySelector(".capsule__text")?.textContent?.trim();
      return text || null;
    })
    .catch(() => null);
}

// 在页面（含所有 iframe）里抓一轮字段；一个都没抓到时返回 null
async function extractFieldsOnce(page: Page): Promise<TapdStoryFields | null> {
  await scrollAllToBottom(page);

  const panel = await readRightPanel(page);
  const targets: Locatable[] = [page, ...page.frames()];

  // TAPD 上确认为空（页面显示"-"）的字段，交给上层用于清空工单里的对应值
  const emptyFields: string[] = [];

  // 优先用上面按真实结构读到的值；读不到再退回早期那套"按标签找相邻节点"的通用兜底策略。
  // fieldName 既是记入 emptyFields 用的字段名（跟工单字段表口径一致），
  // 也是页面上默认要找的标签文字；标签文字跟字段名不一致时用 labels 覆盖
  async function findLabel(fieldName: string, ...labels: string[]): Promise<string | null> {
    const keys = labels.length ? labels : [fieldName];
    for (const key of keys) {
      if (panel[key]) return panel[key];
    }
    // 结构化面板里有这个标签但值是空的 -> TAPD上确实没填
    if (keys.some((k) => k in panel)) {
      emptyFields.push(fieldName);
      return null;
    }
    for (const key of keys) {
      for (const target of targets) {
        const v = await getFieldValueByLabel(target, key);
        if (v && v !== "-") return v;
      }
    }
    return null;
  }

  const tapdStatus = (await readStatus(page)) ?? (await findLabel("TAPD状态", "状态"));
  const estimatedHours = parseHours(await findLabel("预估工时"));
  const actualHours = parseHours(await findLabel("完成工时", "完成工时", "消耗工时"));
  const developer = parseNameList(await findLabel("开发人员"));
  const tester = parseNameList(await findLabel("测试人员"));
  const currentHandler = parseNameList(await findLabel("处理人", "处理人", "当前处理人"))[0] ?? null;
  const iterationName = await findLabel("迭代");
  const monthlyPlan = parseNameList(await findLabel("月度计划"));

  // 页面确实渲染出字段面板了就算抓到（哪怕字段值全是"-"，那也是有效结果，
  // 说明这条需求在TAPD上就是没填），不能因为"值都是空的"就当成还没加载完继续空等
  const gotAnything =
    tapdStatus ||
    estimatedHours !== null ||
    actualHours !== null ||
    developer.length ||
    tester.length ||
    currentHandler ||
    iterationName ||
    monthlyPlan.length ||
    emptyFields.length;
  if (!gotAnything) return null;
  return {
    tapdStatus,
    estimatedHours,
    actualHours,
    developer,
    tester,
    currentHandler,
    iterationName,
    // 页面上只能看到迭代名称，起止日期拿不到
    iterationStart: null,
    iterationEnd: null,
    monthlyPlan,
    subStories: null, // 子需求列表由 extractSubStories 单独尝试补齐
    emptyFields,
  };
}

// 尝试切到"子需求"页签并抓取子需求列表。整个过程是尽力而为：
// 页签不存在（该需求没有子需求）、表格结构认不出来等情况一律返回 null，
// 不影响主字段的同步结果（工单原有的子需求数据保持不动）
async function extractSubStories(page: Page): Promise<TapdSubStoryFields[] | null> {
  try {
    // 详情页页签栏里"子需求"是 li#SubStories，后面 <label> 里带着数量，如 (0) / (3)
    const tab = page.locator("li#SubStories");
    if ((await tab.count()) === 0) return null;

    // 数量为 0 时不用点进去了，直接判定"确认没有子需求"（返回空数组而非 null，
    // 这样上层会把工单的子需求清空，而不是保留过时数据）
    const countText = (await tab.locator("label").first().textContent().catch(() => "")) ?? "";
    if (/\(\s*0\s*\)/.test(countText)) return [];

    await tab.click({ timeout: 10000 });
    await page.waitForTimeout(5000);
    await scrollAllToBottom(page);

    // 子需求列表一般渲染成表格：表头含"标题"，行内是各子需求的字段
    for (const target of [page, ...page.frames()] as Locatable[]) {
      const rows = await target
        .evaluate(() => {
          const tables = Array.from(document.querySelectorAll("table"));
          for (const table of tables) {
            const headers = Array.from(table.querySelectorAll("thead th, thead td")).map((th) =>
              (th.textContent ?? "").trim()
            );
            if (!headers.some((h) => h.includes("标题") || h.includes("名称"))) continue;
            return Array.from(table.querySelectorAll("tbody tr")).map((tr) => {
              const cells = Array.from(tr.querySelectorAll("td"));
              const row: Record<string, string> = {};
              headers.forEach((h, i) => {
                if (h) row[h] = (cells[i]?.textContent ?? "").trim();
              });
              // 标题列里如果有链接，一并带出链接地址（用于子需求的TAPD地址）
              const link = tr.querySelector("a[href*='story']") as HTMLAnchorElement | null;
              if (link?.href) row.__href = link.href;
              return row;
            });
          }
          return null;
        })
        .catch(() => null);

      if (rows && rows.length > 0) {
        const pick = (row: Record<string, string>, ...keys: string[]) => {
          for (const k of Object.keys(row)) {
            if (keys.some((key) => k.includes(key))) return row[k];
          }
          return "";
        };
        return rows.map((row, idx) => ({
          storyId: row.__href?.match(/(\d+)(?:[/?#].*)?$/)?.[1] ?? String(idx + 1),
          title: pick(row, "标题", "名称"),
          tapdUrl: row.__href ?? null,
          tapdStatus: pick(row, "状态") || null,
          developer: parseNameList(pick(row, "开发人员")),
          tester: parseNameList(pick(row, "测试人员")),
          currentHandler: pick(row, "处理人") || null,
          estimatedHours: parseHours(pick(row, "预估工时")),
          actualHours: parseHours(pick(row, "完成工时", "消耗工时")),
          iterationName: pick(row, "迭代") || null,
        }));
      }
    }
    return null;
  } catch {
    return null;
  }
}

// 在"当前已经停在某个需求详情页"的前提下，反复尝试抓取主字段直到渲染稳定或超时。
//
// 之前的做法是"页面上出现任意文字就认为加载完成，然后只抓取一次"——但详情页的侧边栏/菜单等
// 骨架文字远早于详情内容出现（实测详情区域会白屏很久），一次性抓取几乎必然赶在内容渲染前，
// 空手而归后直接报错。这跟当曲云微前端首屏的问题同类，用同样的解法：反复尝试抓取，
// 抓到字段或超时才停，顺带在循环里检查是否撞上WAF拦截页。
//
// 另外不能"抓到任意一个字段就立刻返回"：详情页左侧主内容（状态等）先渲染、右侧"基础信息"
// 面板（工时/开发人员/处理人等）明显更晚，过早返回会导致右侧字段全是空的。所以抓到字段后
// 继续在页面上停留、反复重抓，直到字段数量连续多轮不再增加（说明右侧也渲染完了）才返回
async function extractStoryDetailFields(page: Page, timeoutMs: number): Promise<TapdStoryFields> {
  const deadline = Date.now() + timeoutMs;
  const countFields = (f: TapdStoryFields) =>
    (f.tapdStatus ? 1 : 0) +
    (f.estimatedHours !== null ? 1 : 0) +
    (f.actualHours !== null ? 1 : 0) +
    (f.developer.length ? 1 : 0) +
    (f.tester.length ? 1 : 0) +
    (f.currentHandler ? 1 : 0) +
    (f.iterationName ? 1 : 0) +
    (f.monthlyPlan.length ? 1 : 0);
  const TOTAL_FIELDS = 8;
  // 字段数量连续5轮（约15秒）没有再增加，就认为页面已经渲染稳定，接受当前结果
  // （部分字段在TAPD上本来就可能是空的，所以不能死等到全部抓到）
  const STABLE_ROUNDS = 5;

  let best: TapdStoryFields | null = null;
  let bestCount = 0;
  let stableRounds = 0;
  while (Date.now() < deadline) {
    if (await isWafBlocked(page)) {
      await dumpDebug(page, "waf-blocked");
      throw new Error("访问TAPD需求详情页被安全网关拦截（浏览器被识别为自动化工具），需要调整反检测配置");
    }
    const fields = await extractFieldsOnce(page);
    if (fields) {
      const count = countFields(fields);
      if (count > bestCount) {
        best = fields;
        bestCount = count;
        stableRounds = 0;
        if (count >= TOTAL_FIELDS) return fields; // 全部字段到手，不用再等了
      } else {
        stableRounds += 1;
        if (stableRounds >= STABLE_ROUNDS) return best!;
      }
    }
    await page.waitForTimeout(3000);
  }

  if (best) return best; // 超时但好歹抓到了一部分，能同步多少是多少
  await dumpDebug(page, "no-fields-matched");
  throw new Error(
    `等待${Math.round(timeoutMs / 60000)}分钟仍未能识别到任何TAPD字段：页面内容一直没有渲染出来，或页面结构与预期不符（截图/HTML已存到 backend/.auth/debug/）`
  );
}

export async function scrapeTapdStoryFields(page: Page, tapdUrl: string): Promise<TapdStoryFields> {
  // 实测：直接跳到需求详情深链接会被应用自己重定向回该空间的"需求列表"页
  // （用户在自己日常登录的浏览器里直接访问同一个地址是正常的），所以先到列表页热身，
  // 再用真实点击（而非 page.goto，会被同样的机制拦截/取消导航）跳到具体详情地址
  const listUrl = deriveWorkspaceListUrl(tapdUrl);
  if (listUrl) {
    await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 600000 }).catch(() => {});
    await waitForContentToLoad(page);
    await clickToNavigate(page, tapdUrl);
  } else {
    // 极少数情况下解析不出空间 id，退化成直接跳转；net::ERR_ABORTED 常见于目标页面自己
    // 用客户端路由拦截、取消了这次导航（页面实际可能已经正确切换过去了），不能当成致命错误
    await page.goto(tapdUrl, { waitUntil: "domcontentloaded", timeout: 600000 }).catch(() => {});
  }

  // 主需求详情页：最长等10分钟；抓完把现场存档，便于核对字段是不是抓对了
  const fields = await extractStoryDetailFields(page, 600000);
  await dumpDebug(page, "extracted");

  // 子需求：先切"子需求"页签拿到列表（标题/链接与行内字段），再逐条真实点击进入
  // 每条子需求自己的详情页，用与主需求相同的"停留到字段渲染稳定"方式抓取——
  // 页签表格里的行内值只作为进不去详情页时的兜底
  fields.subStories = await extractSubStories(page);
  if (fields.subStories && fields.subStories.length > 0) {
    await dumpDebug(page, "substories-tab");
    for (const sub of fields.subStories) {
      if (!sub.tapdUrl) continue;
      try {
        await clickToNavigate(page, sub.tapdUrl);
        // 子需求详情页单条最多等3分钟（子需求可能有多条，不能每条都按10分钟预算）
        const detail = await extractStoryDetailFields(page, 180000);
        // 详情页抓到的值优先；没抓到的字段保留页签行内的兜底值
        if (detail.tapdStatus) sub.tapdStatus = detail.tapdStatus;
        if (detail.estimatedHours !== null) sub.estimatedHours = detail.estimatedHours;
        if (detail.actualHours !== null) sub.actualHours = detail.actualHours;
        if (detail.developer.length) sub.developer = detail.developer;
        if (detail.tester.length) sub.tester = detail.tester;
        if (detail.currentHandler) sub.currentHandler = detail.currentHandler;
        if (detail.iterationName) sub.iterationName = detail.iterationName;
        await dumpDebug(page, "substory-extracted");
      } catch (e) {
        // 单条子需求抓取失败不影响其他子需求与主字段，保留行内兜底值
        console.warn(`[tapd] 子需求详情抓取失败（${sub.tapdUrl}）：`, (e as Error).message);
      }
    }
  }

  return fields;
}

// 自包含的浏览器抓取入口：每次调用自己起浏览器、复用已保存的登录态、抓完关闭。
// 供 TAPD_FETCH_MODE=browser 模式下的单条/批量同步使用（批量下逐条起浏览器，会比较慢）
export async function scrapeTapdStoryFieldsViaBrowser(tapdUrl: string): Promise<TapdStoryFields> {
  const browser = await launchTapdBrowser();
  try {
    const { page } = await getTapdAuthenticatedContext(browser);
    return await scrapeTapdStoryFields(page, tapdUrl);
  } finally {
    await browser.close().catch(() => {});
  }
}
