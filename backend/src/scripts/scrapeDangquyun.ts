import fs from "fs";
import path from "path";
import { scrapeDangquyunTicketList } from "../scrapers/dangquyunScraper";

async function main() {
  console.log("[dangquyun] 开始抓取...");
  const result = await scrapeDangquyunTicketList();
  console.log(`[dangquyun] 抓取策略: ${result.strategy}，共 ${result.rows.length} 行`);

  const outPath = path.join(__dirname, "../../.auth/latest-scrape.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");
  console.log(`[dangquyun] 结果已保存到 backend/.auth/latest-scrape.json`);

  if (result.rows.length > 0) {
    console.log("[dangquyun] 前 3 行预览：");
    console.log(JSON.stringify(result.rows.slice(0, 3), null, 2));
  }
}

main().catch((err) => {
  console.error("[dangquyun] 抓取失败：", err.message);
  process.exit(1);
});
