import { Browser, chromium, LaunchOptions } from "playwright";

/**
 * 启动浏览器，系统 Chrome 起不来时自动回退到 Playwright 自带的 Chromium。
 *
 * 默认走 channel: "chrome" 复用本机已装的 Chrome，省去下载内核。但这条路容易在
 * launch 阶段就崩掉，报成 "Target page, context or browser has been closed" 这种
 * 跟业务毫无关系、也无从下手的错。最常见的原因是本机 Chrome 已经开着：
 * macOS 上再启动一次 Google Chrome.app，新进程会把请求交给已有实例后自己退出，
 * Playwright 等不到调试端口，随后收尸还会报 kill EPERM。此外版本不兼容、
 * 被系统安全策略拦截也会有类似表现。
 *
 * 自带内核是独立的一份，不受本机 Chrome 是否开着影响，所以这里自动换用它再试一次；
 * 两条路都失败时，把两个原因都带上，并写清楚该怎么处理。
 */
export async function launchChromiumWithFallback(options: LaunchOptions): Promise<Browser> {
  const { channel, ...rest } = options;
  if (!channel) return chromium.launch(options);

  try {
    return await chromium.launch(options);
  } catch (e) {
    const chromeError = (e as Error).message ?? String(e);
    console.warn(
      `[browser] 使用系统 Chrome（channel=${channel}）启动失败，自动改用 Playwright 自带 Chromium 重试。原始错误：${chromeError}`
    );
    try {
      return await chromium.launch(rest);
    } catch (e2) {
      const bundledError = (e2 as Error).message ?? String(e2);
      throw new Error(
        `浏览器启动失败。\n` +
          `1) 系统 Chrome（channel=${channel}）：${chromeError}\n` +
          `2) Playwright 自带 Chromium：${bundledError}\n` +
          `处理方式（按顺序试）：\n` +
          `  a. 先完全退出本机 Chrome（macOS 用 Cmd+Q，关窗口不算），再重试；\n` +
          `  b. 在 backend 目录执行 npx playwright install chromium 安装自带内核；\n` +
          `  c. 在 backend/.env 里把 DANGQUYUN_BROWSER_CHANNEL / TAPD_BROWSER_CHANNEL 留空，直接使用自带内核。`
      );
    }
  }
}
