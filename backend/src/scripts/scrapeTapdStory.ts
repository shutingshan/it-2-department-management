/**
 * 独立调试脚本：给定一个 TAPD 需求详情页地址，跑一次浏览器模式抓取（含子需求），
 * 结果打印到控制台。用于单独验证 tapdScraper.ts 的选择器/滚动逻辑，
 * 不需要起后端、不需要工单中心里有对应的真实工单数据。
 *
 * 运行前需要：
 * 1. backend/.env 配置 TAPD_FETCH_MODE=browser（不影响正式环境默认的 api 模式，只是这次调试用）
 * 2. 已执行过 `npm run tapd:login` 完成扫码登录、保存好登录态
 * 3. 建议同时配 TAPD_DEBUG=true：抓取全程用可见浏览器（TAPD 场景下无论是否 debug 都是非无头模式，
 *    因为无头模式会被 WAF 拦截），debug 模式下失败/每个关键节点还会额外把截图/HTML 存到
 *    backend/.auth/debug/，方便核对页面结构
 *
 * 用法：npm run scrape:tapd-story -- <TAPD需求详情页地址>
 */
import { scrapeTapdStoryFieldsViaBrowser } from "../scrapers/tapdScraper";

const url = process.argv[2];
if (!url) {
  console.error("用法：npm run scrape:tapd-story -- <TAPD需求详情页地址>");
  process.exit(1);
}

scrapeTapdStoryFieldsViaBrowser(url)
  .then((fields) => {
    console.log(JSON.stringify(fields, null, 2));
    console.log(
      `子需求：${
        fields.subStories === null ? "null（未能确认子需求情况）" : `${fields.subStories.length} 条`
      }`
    );
    process.exit(0);
  })
  .catch((e) => {
    console.error("[tapd] 抓取失败：", e.message ?? e);
    process.exit(1);
  });
