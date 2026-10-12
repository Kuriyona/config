/**
 * cli.ts — 客户端入口：argv 解析、环境变量、退出码。
 *
 *   bun src/cli.ts [status|push|pull] [--dry-run] [--prune] [--json]
 *
 * 环境变量见 .env.example（唯一真源）。默认 SYNC_ROOT = <仓库根>/payload，
 * SYNC_FILTERS = <仓库根>/sync-filters.txt，SYNC_STATE_DIR = <SYNC_ROOT>/.sync。
 * 退出码：0 一致/全部成功，1 有 pending/冲突/被保留项，2 参数或网络错误。
 */
import path from "node:path";
import { deviceId } from "./core.ts";
import { runPull, runPush, runStatus, type ClientOpts } from "./client.ts";

const REPO_ROOT = path.dirname(import.meta.dir);

const USAGE = `用法：bun src/cli.ts [status|push|pull] [--dry-run] [--prune] [--json]

  status   对比本地、基线与服务端（默认命令）
  push     把本地改动推到服务端
  pull     把服务端改动拉到本地

  --dry-run  push/pull 只报告不写盘
  --prune    pull 时删除服务端已删且本地未改过的文件
  --json     机器可读输出

环境变量（见 .env.example）：SYNC_URL 必填；SYNC_TOKEN、SYNC_ROOT、SYNC_DEVICE、
SYNC_STATE_DIR、SYNC_FILTERS 可选。`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

const KNOWN = ["status", "push", "pull"];
const FLAGS = ["--dry-run", "--prune", "--json"];
const positional = args.filter((a) => !a.startsWith("-"));
const unknownFlag = args.find((a) => a.startsWith("-") && !FLAGS.includes(a));
const unknownWord = positional.find((a) => !KNOWN.includes(a));
if (unknownFlag || unknownWord) {
  console.error(`未知参数：${unknownFlag ?? unknownWord}\n\n${USAGE}`);
  process.exit(2);
}
const command = (positional[0] ?? "status") as "status" | "push" | "pull";

const url = process.env.SYNC_URL?.trim();
if (!url) {
  console.error("SYNC_URL 未设置（例如 http://127.0.0.1:8787；见 .env.example）");
  process.exit(2);
}

const resolveFrom = (value: string, base: string): string =>
  path.isAbsolute(value) ? value : path.resolve(base, value);

const root = resolveFrom(process.env.SYNC_ROOT?.trim() || "./payload", REPO_ROOT);
const stateDir = resolveFrom(process.env.SYNC_STATE_DIR?.trim() || "./.sync", root);
const filters = resolveFrom(process.env.SYNC_FILTERS?.trim() || "./sync-filters.txt", REPO_ROOT);

const opts: ClientOpts = {
  root,
  url,
  token: process.env.SYNC_TOKEN?.trim() || "",
  stateDir,
  filters,
  device: deviceId(),
  dryRun: args.includes("--dry-run"),
  prune: args.includes("--prune"),
  json: args.includes("--json"),
};

const code =
  command === "push" ? await runPush(opts) : command === "pull" ? await runPull(opts) : await runStatus(opts);
process.exit(code);
