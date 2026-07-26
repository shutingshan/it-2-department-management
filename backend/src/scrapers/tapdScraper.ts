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
import { BrowserContext, Frame, Page } from "playwright";
import { config } from "../config";

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

// TAPD 需求详情页数据多为异步加载，页面骨架可能先于实际字段渲染出来；
// 最多等 2 分钟让内容真正加载完，而不是固定睡一小段时间就去抓取
async function waitForContentToLoad(page: Page, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await page.evaluate(() => document.body?.innerText?.trim().length ?? 0);
      if (text > 0) {
        await page.waitForTimeout(1000);
        return;
      }
    } catch {
      // 页面这期间又发生了一次内部跳转/刷新，执行上下文失效，当作"还没准备好"继续等
    }
    await page.waitForTimeout(500);
  }
}

export async function scrapeTapdStoryFields(context: BrowserContext, tapdUrl: string): Promise<TapdStoryFields> {
  const page = await context.newPage();
  try {
    await page.goto(tapdUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    await waitForContentToLoad(page);
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

    const gotAnything = tapdStatus || estimatedHours !== null || actualHours !== null || developer.length || currentHandler;
    if (!gotAnything) {
      await dumpDebug(page, "no-fields-matched");
      throw new Error(
        "未能识别到任何TAPD字段，页面结构可能与预期不符（选择器为通用猜测，需要根据真实页面调整）"
      );
    }

    return { tapdStatus, estimatedHours, actualHours, developer, currentHandler };
  } finally {
    await page.close();
  }
}
