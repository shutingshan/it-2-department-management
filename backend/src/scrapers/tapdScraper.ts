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

export interface TapdStoryFields {
  tapdStatus: string | null;
  estimatedHours: number | null;
  actualHours: number | null;
  developer: string[];
  currentHandler: string | null;
}

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

// 在页面（含所有 iframe）里按标签抓一轮字段；一个都没抓到时返回 null
async function extractFieldsOnce(page: Page): Promise<TapdStoryFields | null> {
  const targets: Locatable[] = [page, ...page.frames()];

  async function findLabel(...labels: string[]): Promise<string | null> {
    for (const label of labels) {
      for (const target of targets) {
        const v = await getFieldValueByLabel(target, label);
        if (v) return v;
      }
    }
    return null;
  }

  const tapdStatus = await findLabel("状态");
  const estimatedHours = parseHours(await findLabel("预估工时"));
  const actualHours = parseHours(await findLabel("完成工时", "消耗工时"));
  const developer = parseNameList(await findLabel("开发人员"));
  const currentHandler = await findLabel("处理人", "当前处理人");

  const gotAnything =
    tapdStatus || estimatedHours !== null || actualHours !== null || developer.length || currentHandler;
  if (!gotAnything) return null;
  return { tapdStatus, estimatedHours, actualHours, developer, currentHandler };
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

  // 之前的做法是"页面上出现任意文字就认为加载完成，然后只抓取一次"——但详情页的侧边栏/菜单等
  // 骨架文字远早于详情内容出现（实测详情区域会白屏很久），一次性抓取几乎必然赶在内容渲染前，
  // 空手而归后直接报错。这跟当曲云微前端首屏的问题同类，用同样的解法：反复尝试抓取，
  // 抓到字段或超时（10分钟）才停，顺带在循环里检查是否撞上WAF拦截页。
  //
  // 另外不能"抓到任意一个字段就立刻返回"：详情页左侧主内容（状态等）先渲染、右侧"基础信息"
  // 面板（工时/开发人员/处理人）明显更晚，过早返回会导致右侧字段全是空的。所以抓到字段后
  // 继续在页面上停留、反复重抓，直到字段数量连续多轮不再增加（说明右侧也渲染完了）才返回
  const deadline = Date.now() + 600000;
  const countFields = (f: TapdStoryFields) =>
    (f.tapdStatus ? 1 : 0) +
    (f.estimatedHours !== null ? 1 : 0) +
    (f.actualHours !== null ? 1 : 0) +
    (f.developer.length ? 1 : 0) +
    (f.currentHandler ? 1 : 0);
  const TOTAL_FIELDS = 5;
  // 字段数量连续5轮（约15秒）没有再增加，就认为页面已经渲染稳定，接受当前结果
  // （部分字段在TAPD上本来就可能是空的，所以不能死等到5个全抓到）
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
        if (count >= TOTAL_FIELDS) return fields; // 5个字段全到手，不用再等了
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
    "等待10分钟仍未能识别到任何TAPD字段：页面内容一直没有渲染出来，或页面结构与预期不符（截图/HTML已存到 backend/.auth/debug/）"
  );
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
