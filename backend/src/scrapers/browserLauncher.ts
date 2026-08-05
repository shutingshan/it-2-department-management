import { Browser, chromium, LaunchOptions } from "playwright";

/**
 * 启动浏览器，系统 Chrome 起不来时自动回退到 Playwright 自带的 Chromium。
 *
 * 默认走 channel: "chrome" 复用本机已装的 Chrome，省去下载内核。但这条路会因为
 * 本机 Chrome 版本不兼容、被系统安全策略拦截（macOS 上常见 crashpad bootstrap 失败、
 * kill EPERM）等原因，在 launch 阶段就直接崩掉，报成
 * "Target page, context or browser has been closed" 这种跟业务毫无关系的错。
 *
 * 这类失败对使用者来说没有任何可操作性，所以这里自动换用自带内核再试一次；
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
          `处理方式：在 backend 目录执行 npx playwright install chromium 安装自带内核，` +
          `或在 backend/.env 里把 DANGQUYUN_BROWSER_CHANNEL / TAPD_BROWSER_CHANNEL 留空以直接使用自带内核。`
      );
    }
  }
}
