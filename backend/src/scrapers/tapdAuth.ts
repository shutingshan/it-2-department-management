/**
 * TAPD（tapd.cn）登录态管理。
 *
 * 与当曲云不同，TAPD 用扫码登录，没有账号密码，因此不能像 dangquyunAuth 那样在无头模式下
 * 自动完成登录：扫码这一步必须有一块真实屏幕、由人拿手机扫。
 *
 * 实测下来，无头（headless）模式访问 tapd.cn 会被腾讯云WAF识别成自动化工具直接拦截/卡死
 * （返回403拦截页，或者请求直接挂起没有响应），加了UA伪装、去自动化特征位等常规反检测手段
 * 之后仍然如此。所以正常同步（含单条点击同步、批量获取TAPD信息、每日定时任务）也都统一改成
 * 非无头模式：会自动弹出一个真实可见的浏览器窗口、全自动完成导航/抓取/关闭，不需要人工操作，
 * 但运行期间窗口会短暂出现在屏幕上（批量任务耗时较长时窗口会一直开着，单条同步很快就会自动关闭）。
 * 这也意味着 TAPD 同步只能在有真实图形界面的机器上运行（跟 `npm run tapd:login` 一样）。
 *
 * 扫码登录本身仍只能通过 `npm run tapd:login`（backend/src/scripts/tapdLogin.ts）手动跑一次，
 * 扫码后登录态保存下来，之后的自动同步才能直接复用、不需要再次扫码。
 *
 * 选择器为通用策略实现，未经真实 tapd.cn 页面验证；如与实际页面结构不符，
 * 把 backend/.auth/debug/ 下的截图/HTML 发回来，再针对性调整。
 */
import fs from "fs";
import path from "path";
import readline from "readline";
import { Browser, BrowserContext, Page, chromium } from "playwright";
import { config } from "../config";

const AUTH_DIR = path.join(__dirname, "../../.auth");
const STATE_PATH = path.join(AUTH_DIR, "tapd-state.json");
const DEBUG_DIR = path.join(AUTH_DIR, "debug");

function ensureDirs() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  if (config.tapd.debug) fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

async function gotoAndSettle(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 240000 });
  const deadline = Date.now() + 240000;
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

async function dumpDebug(context: BrowserContext, label: string) {
  if (!config.tapd.debug) return;
  ensureDirs();
  const page = context.pages()[0];
  if (!page) return;
  const stamp = Date.now();
  try {
    await page.screenshot({ path: path.join(DEBUG_DIR, `${stamp}-tapd-${label}.png`), fullPage: true });
    fs.writeFileSync(path.join(DEBUG_DIR, `${stamp}-tapd-${label}.html`), await page.content());
    console.log(`[tapd] 调试信息已保存: .auth/debug/${stamp}-tapd-${label}.{png,html}`);
  } catch (e) {
    console.warn(`[tapd] 保存调试信息失败（${label}）`, (e as Error).message);
  }
}

// 粗略判断当前是否处于"未登录"状态：URL 带 login/passport/sso 关键字，
// 或页面上出现明显的二维码元素（TAPD 统一登录页通常会展示扫码登录的二维码图片）
async function looksLoggedOut(context: BrowserContext): Promise<boolean> {
  const page = context.pages()[0];
  if (!page) return true;
  const url = page.url();
  if (/passport|login|sso/i.test(url)) return true;
  const qrCount = await page
    .locator('img[src*="qrcode" i], canvas, [class*="qrcode" i], [class*="qr-code" i]')
    .count()
    .catch(() => 0);
  return qrCount > 0;
}

// 部分安全网关（如腾讯云WAF）会把自动化浏览器的请求直接识别成"疑似攻击"并拦截，返回一个
// 403 拦截页而不是真正的TAPD页面；这种情况跟"未登录"/"页面结构不对"是完全不同的问题
// （前者是自动化指纹被风控命中，后者才需要调整选择器），单独识别出来才能给出准确的报错
export async function isWafBlocked(page: Page): Promise<boolean> {
  try {
    const title = await page.title();
    if (/WAF|拦截/i.test(title)) return true;
    const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    return /您的请求已中断|Web应用防护服务|腾讯云WAF/.test(text);
  } catch {
    return false;
  }
}

// 终端里等用户按回车：真实登录流程可能需要先点"登录"按钮才会出现二维码，
// 步骤数、页面结构都是猜的，与其用选择器猜"是否已登录"（猜错就会在用户还没来得及操作时
// 提前判定"已登录"并把浏览器关掉），不如让用户自己确认完成登录后再继续——更慢但绝对不会出错
function waitForEnter(promptText: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

// 常见桌面 Chrome 的 UA/视口，加上给每个新页面patch掉 navigator.webdriver
// （Playwright 默认会暴露这个字段，是最基础的自动化特征之一，容易被风控命中），
// 作为多一层防护——即便已经改成非无头模式，这些依然是无害的额外保险
const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

async function newStealthContext(browser: Browser, storageState?: string): Promise<BrowserContext> {
  const context = await browser.newContext({
    ...(storageState ? { storageState } : {}),
    userAgent: DESKTOP_USER_AGENT,
    viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  return context;
}

// 自动同步（单条点击同步、批量获取TAPD信息、每日定时任务）调用：只复用已保存的登录态，
// 登录态无效则直接抛错。非无头模式运行，会自动弹出一个可见的浏览器窗口完成后续操作，
// 全程无需人工干预，但需要机器上有真实图形界面（同 `npm run tapd:login` 的前提）
export async function getTapdAuthenticatedContext(browser: Browser): Promise<BrowserContext> {
  ensureDirs();
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(
      "TAPD 尚未登录：请在有屏幕的本机执行一次 `npm run tapd:login`，扫码登录后再重试同步。"
    );
  }
  const context = await newStealthContext(browser, STATE_PATH);
  const page = await context.newPage();
  await gotoAndSettle(page, config.tapd.baseUrl);

  if (await isWafBlocked(page)) {
    await dumpDebug(context, "waf-blocked");
    throw new Error(
      "访问TAPD被安全网关拦截，需要调整反检测配置，请把 backend/.auth/debug/ 里最新的 waf-blocked 截图/HTML 发给开发者。"
    );
  }

  if (await looksLoggedOut(context)) {
    await dumpDebug(context, "session-expired");
    throw new Error(
      "TAPD 登录态已过期：请在有屏幕的本机重新执行一次 `npm run tapd:login` 扫码登录后再重试同步。"
    );
  }
  return context;
}

// 交互式登录（仅供 tapdLogin.ts 调用）：非无头模式打开浏览器，人工完成登录（可能需要先点"登录"
// 按钮才会出现二维码，再扫码），由用户自己在终端按回车确认登录完成后才保存登录态并关闭浏览器——
// 不靠选择器猜"是否已登录"，避免猜错导致浏览器在用户还没操作完就被提前关掉
export async function performInteractiveLogin(): Promise<void> {
  ensureDirs();
  const browser = await chromium.launch({
    headless: false,
    channel: config.tapd.browserChannel,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    // 登录态保存下来后会被自动同步的浏览器复用，这里也用同一套 UA/视口，减少"建立会话"和"复用会话"
    // 两次请求指纹不一致的情况（这种不一致本身也是风控可能盯上的信号）
    const context = await newStealthContext(browser);
    const page = await context.newPage();
    await gotoAndSettle(page, config.tapd.baseUrl);
    await dumpDebug(context, "before-manual-login");

    console.log("[tapd] 浏览器窗口已打开，请在该窗口里手动完成登录（可能需要先点击登录按钮，再扫码）。");
    await waitForEnter("[tapd] 完成登录后回到这里，按回车键继续保存登录态：");

    await dumpDebug(context, "after-manual-login");
    await context.storageState({ path: STATE_PATH });
    console.log(`[tapd] 登录态已保存到 ${STATE_PATH}`);
  } finally {
    await browser.close();
  }
}

// 自动同步用的浏览器：非无头模式（会弹出真实可见窗口），因为无头模式访问 tapd.cn 会被
// 安全网关拦截/卡死。全程自动操作，不需要人工干预，只是运行期间窗口会短暂出现在屏幕上
export async function launchTapdBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: false,
    channel: config.tapd.browserChannel,
    // 关掉 Chromium 用来标记"这是被自动化控制的浏览器"的特征位，降低被风控识别为爬虫的概率
    args: ["--disable-blink-features=AutomationControlled"],
  });
}
