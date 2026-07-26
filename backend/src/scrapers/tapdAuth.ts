/**
 * TAPD（tapd.cn）登录态管理。
 *
 * 与当曲云不同，TAPD 用扫码登录，没有账号密码，因此不能像 dangquyunAuth 那样在无头模式下
 * 自动完成登录：扫码这一步必须有一块真实屏幕、由人拿手机扫。这里的设计是：
 * - 正常同步（含每日定时任务）永远以无头模式复用已保存的登录态（backend/.auth/tapd-state.json），
 *   登录态有效就直接用，没有/过期了就直接抛错，不会在服务器上弹出看不见的浏览器窗口空等。
 * - 真正的扫码登录只能通过 `npm run tapd:login`（backend/src/scripts/tapdLogin.ts）在有屏幕的
 *   本机以非无头模式手动跑一次，扫码后登录态会保存下来，之后无头同步/定时任务才能复用。
 *
 * 选择器为通用策略实现，未经真实 tapd.cn 页面验证；如与实际页面结构不符，
 * 把 backend/.auth/debug/ 下的截图/HTML 发回来，再针对性调整。
 */
import fs from "fs";
import path from "path";
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
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  const deadline = Date.now() + 30000;
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

// 等待用户用手机扫码完成登录（仅供 tapdLogin.ts 交互式登录脚本调用，非无头模式下才有意义）
async function waitForQrLogin(context: BrowserContext, page: Page, timeoutMs = 120000) {
  console.log("[tapd] 检测到尚未登录，请在弹出的浏览器窗口中使用手机 TAPD/企业微信扫码登录……");
  await dumpDebug(context, "qrcode-waiting");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await looksLoggedOut(context))) {
      console.log("[tapd] 已检测到登录成功");
      return;
    }
    await page.waitForTimeout(1000);
  }
  await dumpDebug(context, "qrcode-timeout");
  throw new Error(`等待扫码登录超时（${Math.round(timeoutMs / 1000)}秒），请重新运行 npm run tapd:login 并尽快扫码`);
}

// 无头同步（含每日定时任务）调用：只复用已保存的登录态，登录态无效则直接抛错，
// 绝不在服务器上弹出无人可见的扫码窗口空等
export async function getHeadlessAuthenticatedContext(browser: Browser): Promise<BrowserContext> {
  ensureDirs();
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(
      "TAPD 尚未登录：请在有屏幕的本机执行一次 `npm run tapd:login`，扫码登录后再重试同步。"
    );
  }
  const context = await browser.newContext({ storageState: STATE_PATH });
  const page = await context.newPage();
  await gotoAndSettle(page, config.tapd.baseUrl);

  if (await looksLoggedOut(context)) {
    await dumpDebug(context, "headless-session-expired");
    throw new Error(
      "TAPD 登录态已过期：请在有屏幕的本机重新执行一次 `npm run tapd:login` 扫码登录后再重试同步。"
    );
  }
  return context;
}

// 交互式登录（仅供 tapdLogin.ts 调用）：非无头模式打开浏览器，等待人工扫码，成功后保存登录态
export async function performInteractiveLogin(): Promise<void> {
  ensureDirs();
  const browser = await chromium.launch({ headless: false, channel: config.tapd.browserChannel });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await gotoAndSettle(page, config.tapd.baseUrl);

    if (await looksLoggedOut(context)) {
      await waitForQrLogin(context, page);
    } else {
      console.log("[tapd] 当前浏览器已是登录状态");
    }

    await context.storageState({ path: STATE_PATH });
    console.log(`[tapd] 登录态已保存到 ${STATE_PATH}`);
  } finally {
    await browser.close();
  }
}

export async function launchHeadlessBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true, channel: config.tapd.browserChannel });
}
