/**
 * server.ts — 配置同步服务端（VPS 上由 PM2 守护）。
 *
 * 权威副本在 SYNC_DATA，覆盖/删除前的旧内容归档到 SYNC_HISTORY；客户端用
 * Authorization: Bearer <SYNC_TOKEN> 访问 /v1/*。并发模型：无全局锁，靠「服务端现值 vs
 * 客户端基线 vs 来件」三方比较逐文件判定，较新者留在原名、落败者存成冲突副本。
 *
 * 启动：bun src/server.ts（相对路径按仓库根解析，PM2 与手工启动行为一致）。
 */
import fs from "node:fs";
import path from "node:path";
import {
  archiveFile,
  assertSafePath,
  hashBytes,
  hashFile,
  listPayloadFiles,
  loadFilters,
  logLine,
  matchFilters,
  readManifest,
  safeEqual,
  utcStamp,
  writeFileAtomic,
  writeManifestAtomic,
  type FilterRule,
  type Manifest,
} from "./core.ts";

const REPO_ROOT = path.dirname(import.meta.dir);
const resolveFromRepo = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p));

const HOST = process.env.SYNC_HOST?.trim() || "127.0.0.1";
const PORT = Number(process.env.SYNC_PORT?.trim() || "8787");
const DATA = resolveFromRepo(process.env.SYNC_DATA?.trim() || "./data");
const HISTORY = resolveFromRepo(process.env.SYNC_HISTORY?.trim() || "./history");
const STATE = resolveFromRepo(process.env.SYNC_STATE_DIR?.trim() || "./.sync-server");
const FILTERS = resolveFromRepo(process.env.SYNC_FILTERS?.trim() || "./sync-filters.txt");
const TOKEN = process.env.SYNC_TOKEN?.trim() || "";

const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"];
if (!LOOPBACK_HOSTS.includes(HOST) && !TOKEN) {
  console.error(`SYNC_HOST=${HOST} 非回环，必须设置 SYNC_TOKEN`);
  process.exit(1);
}

const rules: FilterRule[] = loadFilters(FILTERS);
for (const dir of [DATA, HISTORY, STATE]) fs.mkdirSync(dir, { recursive: true });

let manifest: Manifest = {};

/** 磁盘上有、但不在过滤器内的文件：忽略，并逐条告警（不哈希、不进清单）。 */
function warnIgnored(relDir: string): void {
  const abs = relDir ? path.join(DATA, relDir) : DATA;
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (ent.isSymbolicLink()) continue;
    const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
    if (ent.isDirectory()) warnIgnored(rel);
    else if (ent.isFile() && !(rel in manifest)) logLine({ level: "warn", msg: "data-ignored", path: rel });
  }
}

let revision = 0;
try {
  const raw = fs.readFileSync(path.join(STATE, "revision"), "utf8").trim();
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed >= 0) revision = parsed;
} catch {}
let updatedAt = new Date().toISOString();

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const notFound = (): Response => json({ ok: false, error: "not-found" }, 404);

function authorized(req: Request): boolean {
  if (!TOKEN) return true;
  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  return header.startsWith(prefix) && safeEqual(header.slice(prefix.length), TOKEN);
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await req.text());
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 用作文件名片段的设备名：只留 [A-Za-z0-9._-]（与 core.deviceId 的合法化规则一致）。 */
function sanitizeTag(raw: unknown): string {
  const tag = String(raw ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return tag || "unknown";
}

type PutRequest = { path: string; hash: string; size: number; data: string };

async function handlePush(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return json({ ok: false, error: "bad-request" }, 400);

  const dryRun = body.dryRun === true;
  const clientManifest = (body.manifest ?? {}) as Manifest;
  const puts = Array.isArray(body.puts) ? (body.puts as PutRequest[]) : [];
  const deletes = Array.isArray(body.deletes) ? (body.deletes as string[]) : [];
  const stamp = utcStamp();
  const tag = sanitizeTag(body.device);

  const applied: { path: string; op: "put" | "delete" }[] = [];
  const conflicts: { path: string; reason: string; serverHash: string | null; savedAs: string | null }[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let touched = false;

  for (const put of puts) {
    const p = String(put?.path ?? "");
    try {
      assertSafePath(p);
    } catch {
      skipped.push({ path: p, reason: "bad-request" });
      continue;
    }
    if (!matchFilters(rules, "/" + p)) {
      skipped.push({ path: p, reason: "path-not-allowed" });
      continue;
    }
    const bytes = new Uint8Array(Buffer.from(String(put.data ?? ""), "base64"));
    const declared = String(put.hash ?? "");
    const actual = hashBytes(bytes);
    if (actual !== declared) {
      skipped.push({ path: p, reason: "hash-mismatch" });
      continue;
    }
    const serverHash = manifest[p]?.hash ?? null;
    const baseHash = clientManifest[p]?.hash ?? null;
    const abs = path.join(DATA, p);

    if (serverHash !== null && serverHash !== declared && serverHash !== baseHash) {
      // 冲突：服务端内容既不是来件、也不是客户端基线 -> 服务端文件保持不动，来件另存。
      let savedAs: string | null = null;
      if (!dryRun) {
        const candidateRel = `${p}.conflict-${tag}-${stamp}`;
        if (matchFilters(rules, "/" + candidateRel)) {
          await writeFileAtomic(path.join(DATA, candidateRel), bytes);
          manifest[candidateRel] = { hash: actual, size: bytes.byteLength };
          touched = true;
          savedAs = candidateRel;
        } else {
          const destAbs = path.join(STATE, "conflicts", `${stamp}-${tag}`, p);
          await writeFileAtomic(destAbs, bytes);
          savedAs = destAbs;
        }
      }
      conflicts.push({ path: p, reason: "server-changed", serverHash, savedAs });
      continue;
    }

    if (!dryRun) {
      if (serverHash !== null && serverHash !== declared) await archiveFile(abs, p, HISTORY, stamp);
      if (serverHash !== declared) {
        await writeFileAtomic(abs, bytes);
        touched = true;
      }
      manifest[p] = { hash: declared, size: bytes.byteLength };
    }
    applied.push({ path: p, op: "put" });
  }

  for (const raw of deletes) {
    const p = String(raw);
    try {
      assertSafePath(p);
    } catch {
      skipped.push({ path: p, reason: "bad-request" });
      continue;
    }
    if (!matchFilters(rules, "/" + p)) {
      skipped.push({ path: p, reason: "path-not-allowed" });
      continue;
    }
    const serverHash = manifest[p]?.hash ?? null;
    const baseHash = clientManifest[p]?.hash ?? null;
    if (serverHash === null) {
      applied.push({ path: p, op: "delete" });
      continue;
    }
    if (serverHash === baseHash) {
      if (!dryRun) {
        const abs = path.join(DATA, p);
        await archiveFile(abs, p, HISTORY, stamp);
        await fs.promises.rm(abs, { force: true });
        delete manifest[p];
        touched = true;
      }
      applied.push({ path: p, op: "delete" });
      continue;
    }
    conflicts.push({ path: p, reason: "base-mismatch", serverHash, savedAs: null });
  }

  if (!dryRun && touched) {
    await writeManifestAtomic(path.join(STATE, "manifest.json"), manifest);
    revision += 1;
    await Bun.write(path.join(STATE, "revision"), String(revision));
    updatedAt = new Date().toISOString();
  }

  return json({ ok: true, revision, applied, conflicts, skipped });
}

async function handlePull(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) return json({ ok: false, error: "bad-request" }, 400);
  const clientManifest = (body.manifest ?? {}) as Manifest;

  const puts: { path: string; hash: string; size: number; data: string }[] = [];
  for (const [p, entry] of Object.entries(manifest)) {
    if (clientManifest[p]?.hash === entry.hash) continue;
    const bytes = new Uint8Array(await Bun.file(path.join(DATA, p)).arrayBuffer());
    puts.push({ path: p, hash: entry.hash, size: entry.size, data: Buffer.from(bytes).toString("base64") });
  }
  const removed = Object.keys(clientManifest).filter((p) => !(p in manifest));
  return json({ ok: true, revision, puts, removed });
}

const startedAt = Date.now();

// 不写顶层 await：PM2 的 bun 容器用 require() 加载本模块，async module 会被拒绝。
void (async () => {
  const initial = await listPayloadFiles(DATA, rules);
  for (const rel of initial) manifest[rel] = await hashFile(path.join(DATA, rel));
  warnIgnored("");

  const server = Bun.serve({
    hostname: HOST,
    port: PORT,
    maxRequestBodySize: 32 * 1024 * 1024,
    routes: {
      "/healthz": () => json({ ok: true, uptime: Math.round((Date.now() - startedAt) / 1000) }),
      "/v1/status": (req) =>
        authorized(req)
          ? json({ ok: true, revision, updatedAt, files: manifest })
          : json({ ok: false, error: "unauthorized" }, 401),
      "/v1/push": (req) => (authorized(req) ? handlePush(req) : json({ ok: false, error: "unauthorized" }, 401)),
      "/v1/pull": (req) => (authorized(req) ? handlePull(req) : json({ ok: false, error: "unauthorized" }, 401)),
    },
    fetch: notFound,
  });

  logLine({
    level: "info",
    msg: "listening",
    url: `http://${HOST}:${server.port}`,
    data: DATA,
    history: HISTORY,
    revision,
    token: TOKEN ? "set" : "none",
  });
})();
