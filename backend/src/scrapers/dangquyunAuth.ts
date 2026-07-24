import fs from "fs";
import path from "path";
import { Browser, BrowserContext, Page, chromium } from "playwright";
import { config } from "../config";

const AUTH_DIR = path.join(__dirname, "../../.auth");
const STATE_PATH = path.join(AUTH_DIR, "dangquyun-state.json");
const DEBUG_DIR = path.join(AUTH_DIR, "debug");

function ensureDirs() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  if (config.dangquyun.debug) fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

// 很多现代网页有长期在跑的心跳请求/埋点/websocket，永远不会真正"网络空闲"，
// 所以这里不等 networkidle，只等 DOM 就绪，再额外缓冲一小段时间给前端渲染/跳转
async function gotoAndSettle(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2000);
}

async function dumpDebug(context: BrowserContext, label: string) {
  if (!config.dangquyun.debug) return;
  ensureDirs();
  const page = context.pages()[0];
  if (!page) return;
  const stamp = Date.now();
  try {
    await page.screenshot({ path: path.join(DEBUG_DIR, `${stamp}-${label}.png`), fullPage: true });
    fs.writeFileSync(path.join(DEBUG_DIR, `${stamp}-${label}.html`), await page.content());
    console.log(`[dangquyun] 调试信息已保存: .auth/debug/${stamp}-${label}.{png,html}`);
  } catch (e) {
    console.warn(`[dangquyun] 保存调试信息失败（${label}）`, (e as Error).message);
  }
}

// 粗略判断当前页面是不是登录页：URL 含 login/signin 关键字，或页面上有明显的密码输入框
async function looksLikeLoginPage(context: BrowserContext): Promise<boolean> {
  const page = context.pages()[0];
  if (!page) return true;
  const url = page.url();
  if (/login|signin|sso/i.test(url)) return true;
  const passwordInput = await page.locator('input[type="password"]').count();
  return passwordInput > 0;
}

async function performLogin(context: BrowserContext) {
  const page = context.pages()[0] ?? (await context.newPage());
  const loginUrl = config.dangquyun.loginUrl || config.dangquyun.targetUrl;

  console.log(`[dangquyun] 未检测到有效登录态，开始登录流程: ${loginUrl}`);
  await gotoAndSettle(page, loginUrl);
  await dumpDebug(context, "login-page-before-fill");

  // 尝试用较通用的方式定位账号/密码输入框和登录按钮；
  // 如果这套定位方式跟当曲云实际页面对不上，把 debug 截图/HTML 发回来，我再针对性调整选择器
  const usernameCandidates = [
    page.getByPlaceholder(/账号|用户名|手机号|邮箱|username|email/i),
    page.locator('input[type="text"]'),
    page.locator('input:not([type="password"]):not([type="hidden"]):not([type="checkbox"])').first(),
  ];
  const passwordCandidates = [page.locator('input[type="password"]')];

  let usernameFilled = false;
  for (const locator of usernameCandidates) {
    if ((await locator.count()) > 0) {
      await locator.first().fill(config.dangquyun.username);
      usernameFilled = true;
      break;
    }
  }
  let passwordFilled = false;
  for (const locator of passwordCandidates) {
    if ((await locator.count()) > 0) {
      await locator.first().fill(config.dangquyun.password);
      passwordFilled = true;
      break;
    }
  }

  if (!usernameFilled || !passwordFilled) {
    await dumpDebug(context, "login-page-fields-not-found");
    throw new Error(
      "找不到账号/密码输入框，登录页结构可能跟预期不一致。请查看 backend/.auth/debug/ 下的截图和 HTML，把结构发回来调整选择器。"
    );
  }

  await dumpDebug(context, "login-page-after-fill");

  const submitCandidates = [
    page.getByRole("button", { name: /登录|登陆|log ?in|sign ?in/i }),
    page.locator('button[type="submit"]'),
  ];
  let clicked = false;
  for (const locator of submitCandidates) {
    if ((await locator.count()) > 0) {
      await locator.first().click();
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    await dumpDebug(context, "login-submit-not-found");
    throw new Error("找不到登录按钮，请查看 backend/.auth/debug/ 下的截图和 HTML 调整选择器。");
  }

  // 提交后页面可能整页跳转，也可能是前端路由跳转（不触发 load 事件），两种都等一下
  await page
    .waitForURL((url) => !/login|signin|sso/i.test(url.toString()), { timeout: 15000 })
    .catch(() => {});
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(2000);
  await dumpDebug(context, "after-submit");

  if (await looksLikeLoginPage(context)) {
    throw new Error("提交登录后仍停留在疑似登录页，账号密码或选择器可能不正确，请检查 backend/.auth/debug/ 下的截图。");
  }

  console.log("[dangquyun] 登录成功，保存登录态");
  ensureDirs();
  await context.storageState({ path: STATE_PATH });
}

export async function getAuthenticatedContext(browser: Browser): Promise<BrowserContext> {
  ensureDirs();
  const hasState = fs.existsSync(STATE_PATH);
  const context = await browser.newContext(hasState ? { storageState: STATE_PATH } : {});
  const page = await context.newPage();

  await gotoAndSettle(page, config.dangquyun.targetUrl);

  if (await looksLikeLoginPage(context)) {
    await performLogin(context);
    // 登录后重新跳转到目标页面
    await gotoAndSettle(page, config.dangquyun.targetUrl);
    if (await looksLikeLoginPage(context)) {
      await dumpDebug(context, "still-login-after-relogin");
      throw new Error("登录后仍无法进入目标页面，请检查账号密码或目标地址是否正确。");
    }
  } else {
    console.log("[dangquyun] 复用已保存的登录态，跳过登录流程");
  }

  return context;
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: !config.dangquyun.debug,
    channel: config.dangquyun.browserChannel,
  });
}
