/**
 * 分析 DANGQUYUN_DEBUG 模式下存到 .auth/debug/ 的当曲云列表接口响应。
 *
 * 目的是把「接口字段代号 → 中文列名」的对照表摸出来：接口返回的字段名全是
 * SerialNumber/Bt/Fl 这类内部代号，不知道哪个对应哪一列就没法改用接口取数。
 *
 * 只打印字段名、类型和列定义，不打印任何业务数据的值，输出可以直接贴出来。
 *
 * 用法：npm run inspect:listapi
 */
import fs from "fs";
import path from "path";

const DEBUG_DIR = path.join(__dirname, "../../.auth/debug");

// 工单列表上这几个中文列名足够特征化，哪个响应里有它们，哪个就带着列定义
const HEADER_PROBE_WORDS = [
  "需求模块",
  "归属应用",
  "受理人",
  "关联TAPD",
  "预计梳理完成",
  "编号",
  "发起人",
  "所属部门",
];

function newestFile(filter: (name: string) => boolean): string | null {
  if (!fs.existsSync(DEBUG_DIR)) return null;
  const files = fs
    .readdirSync(DEBUG_DIR)
    .filter(filter)
    .map((name) => ({ name, mtime: fs.statSync(path.join(DEBUG_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? path.join(DEBUG_DIR, files[0].name) : null;
}

function findLargestObjectArray(root: unknown): { path: string; items: Record<string, unknown>[] } | null {
  let best: { path: string; items: Record<string, unknown>[] } | null = null;
  const walk = (node: unknown, nodePath: string, depth: number) => {
    if (depth > 8 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      const objects = node.filter(
        (v) => v !== null && typeof v === "object" && !Array.isArray(v)
      ) as Record<string, unknown>[];
      if (objects.length > 0 && (!best || objects.length > best.items.length)) {
        best = { path: nodePath, items: objects };
      }
      node.slice(0, 3).forEach((v, i) => walk(v, `${nodePath}[${i}]`, depth + 1));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      walk(value, nodePath ? `${nodePath}.${key}` : key, depth + 1);
    }
  };
  walk(root, "", 0);
  return best;
}

/** 只报字段名和类型，不报值——输出要能安全地贴出来 */
function describeFields(items: Record<string, unknown>[]): void {
  const keys = Object.keys(items[0]);
  console.log(`\n字段共 ${keys.length} 个（只列字段名与类型，不含业务数据）：`);
  for (const key of keys) {
    // 整列都是 null 的字段看不出类型，往后翻几条找第一个有值的
    const sample = items.find((item) => item[key] !== null && item[key] !== undefined)?.[key];
    const type =
      sample === undefined
        ? "整列为空"
        : Array.isArray(sample)
          ? "数组"
          : typeof sample === "object"
            ? "对象"
            : typeof sample === "string" && /^\d{4}-\d{2}-\d{2}T/.test(sample)
              ? "时间"
              : typeof sample;
    console.log(`  ${key.padEnd(28)} ${type}`);
  }
}

/** 在所有已存的调试响应里找列定义：含中文列名的那层对象原样打出来 */
function scanColumnDefinitions(): void {
  if (!fs.existsSync(DEBUG_DIR)) return;
  const files = fs.readdirSync(DEBUG_DIR).filter((n) => n.endsWith(".json"));
  let found = false;
  for (const name of files) {
    const text = fs.readFileSync(path.join(DEBUG_DIR, name), "utf8");
    if (!HEADER_PROBE_WORDS.some((word) => text.includes(word))) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    let printed = 0;
    const walk = (node: unknown, depth: number) => {
      if (printed >= 12 || depth > 10 || node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach((v) => walk(v, depth + 1));
        return;
      }
      const values = Object.values(node);
      if (values.some((v) => typeof v === "string" && HEADER_PROBE_WORDS.includes(v))) {
        if (!printed) console.log(`\n=== ${name} 里含中文列名的对象 ===`);
        console.log(`  ${JSON.stringify(node).slice(0, 300)}`);
        printed += 1;
        return; // 命中的这层就是列定义本身，不再往里钻
      }
      values.forEach((v) => walk(v, depth + 1));
    };
    walk(parsed, 0);
    if (printed) found = true;
  }
  if (!found) {
    console.log("\n没有在任何调试响应里找到含中文列名的对象——列定义可能是页面打开时就请求过了，");
    console.log("抓取时复用登录态没再请求。可以把浏览器的登录态清掉（删 backend/.auth 下的登录态文件）再跑一次。");
  }
}

function main(): void {
  const responseFile = newestFile((n) => n.includes("-list-api-") && !n.includes("-request"));
  if (!responseFile) {
    console.log(`没找到列表接口响应。确认 .env 里 DANGQUYUN_DEBUG=true，跑一次「获取新工单」后再执行本脚本。`);
    console.log(`（期望目录：${DEBUG_DIR}）`);
    return;
  }
  console.log(`=== 响应文件：${path.basename(responseFile)} ===`);
  const parsed = JSON.parse(fs.readFileSync(responseFile, "utf8"));
  const found = findLargestObjectArray(parsed);
  if (!found) {
    console.log("响应里没找到对象数组");
  } else {
    console.log(`最大的对象数组在 ${found.path || "<根>"}，共 ${found.items.length} 条记录`);
    describeFields(found.items);
  }

  const requestFile = newestFile((n) => n.includes("-list-api-") && n.includes("-request"));
  if (requestFile) {
    console.log(`\n=== 请求体：${path.basename(requestFile)} ===`);
    console.log(fs.readFileSync(requestFile, "utf8").slice(0, 4000));
  }

  scanColumnDefinitions();
}

main();
