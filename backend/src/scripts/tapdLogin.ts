/**
 * 交互式 TAPD 扫码登录脚本：只能在有屏幕的本机运行（`npm run tapd:login`），
 * 会弹出一个真实可见的浏览器窗口，用手机 TAPD/企业微信扫码登录后自动保存登录态，
 * 之后无头模式的同步任务（含每日定时任务）才能正常访问 TAPD。
 *
 * 不要在没有显示器的服务器上运行本脚本——非无头浏览器需要真实图形环境。
 */
import { performInteractiveLogin } from "../scrapers/tapdAuth";

performInteractiveLogin()
  .then(() => {
    console.log("[tapd] 登录完成，可以关闭此脚本了。");
    process.exit(0);
  })
  .catch((e) => {
    console.error("[tapd] 登录失败：", e.message ?? e);
    process.exit(1);
  });
