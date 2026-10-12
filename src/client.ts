/**
 * client.ts — 客户端逻辑：status / push / pull。
 *
 * 基线（上次与服务端一致时的清单）存在 <SYNC_STATE_DIR>/state.json。push 只推「相对基线变了」
 * 的文件，pull 只写「本地相对基线没变」的文件；本地有未推送改动时服务端版本另存为
 * `<path>.server-<stamp>`。客户端不建自己的历史目录：删除回滚走服务端的 history/。
 */
import fs from "node:fs";
import path from "node:path";
import {
  hashFile,
  listPayloadFiles,
  loadFilters,
  utcStamp,
  writeFileAtomic,
  type FilterRule,
  type Manifest,
} from "./core.ts";

export type ClientOpts = {
  root: string;
  url: string;
  token: string;
  stateDir: string;
  filters: string;
  device: string;
  dryRun?: boolean;
  prune?: boolean;
  json?: boolean;
};

type ServerFile = { hash: string; size: number };
type StatusResponse = { ok: true; revision: number; updatedAt: string; files: Record<string, ServerFile> };
type PushResponse = {
  ok: true;
  revision: number;
  applied: { path: string; op: "put" | "delete" }[];
  conflicts: { path: string; reason: string; serverHash: string | null; savedAs: string | null }[];
  skipped: { path: string; reason: string }[];
};
type PullResponse = {
  ok: true;
  revision: number;
  puts: { path: string; hash: string; size: number; data: string }[];
  removed: string[];
};

type ClientState = {
  version: 1;
  device: string;
  url: string;
  revision: number;
  lastSyncAt: string;
  manifest: Manifest;
};

class ApiError extends Error {
  code: string;
  constructor(code: string, detail: string) {
    super(`error=${code} detail=${detail}`);
    this.code = code;
  }
}

function sizeText(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}K`;
  return `${(size / (1024 * 1024)).toFixed(1)}M`;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function scanLocal(root: string, rules: FilterRule[]): Promise<Manifest> {
  const out: Manifest = {};
  for (const rel of await listPayloadFiles(root, rules)) out[rel] = await hashFile(path.join(root, rel));
  return out;
}

async function api<T>(opts: ClientOpts, route: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(opts.url + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new ApiError("unreachable", String((err as Error)?.message ?? err));
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    const code = (parsed as { error?: string } | undefined)?.error ?? `http-${res.status}`;
    throw new ApiError(code, text.slice(0, 300));
  }
  return parsed as T;
}

async function loadState(opts: ClientOpts): Promise<ClientState> {
  const file = path.join(opts.stateDir, "state.json");
  let state: ClientState | null = null;
  try {
    state = JSON.parse(await Bun.file(file).text()) as ClientState;
  } catch {
    state = null;
  }
  if (state && state.url && state.url !== opts.url) {
    console.error(
      `state 属于 ${state.url}，当前 ${opts.url}；确认后删除 ${file} 重建基线`,
    );
    process.exit(2);
  }
  return state ?? { version: 1, device: opts.device, url: opts.url, revision: 0, lastSyncAt: "", manifest: {} };
}

async function saveState(opts: ClientOpts, state: ClientState): Promise<void> {
  state.device = opts.device;
  state.url = opts.url;
  state.lastSyncAt = new Date().toISOString();
  await writeFileAtomic(
    path.join(opts.stateDir, "state.json"),
    new TextEncoder().encode(JSON.stringify(state, null, 2) + "\n"),
  );
}

type Row = { status: string; p: string; size: string };

function printTable(rows: Row[]): void {
  const wStatus = Math.max(2, ...rows.map((r) => r.status.length));
  const wPath = Math.max(4, ...rows.map((r) => r.p.length));
  console.log(`${"状态".padEnd(wStatus)}  ${"路径".padEnd(wPath)}  大小`);
  for (const r of rows) console.log(`${r.status.padEnd(wStatus)}  ${r.p.padEnd(wPath)}  ${r.size}`);
}

export async function runStatus(opts: ClientOpts): Promise<number> {
  const rules = loadFilters(opts.filters);
  const state = await loadState(opts);
  const local = await scanLocal(opts.root, rules);
  const base = state.manifest;

  let server: StatusResponse;
  try {
    server = await api<StatusResponse>(opts, "/v1/status");
  } catch (err) {
    console.error(String((err as Error).message));
    return 2;
  }

  const paths = [...new Set([...Object.keys(local), ...Object.keys(base), ...Object.keys(server.files)])].sort();
  const rows: Row[] = [];
  const push: string[] = [];
  const pull: string[] = [];
  const conflicts: string[] = [];
  for (const p of paths) {
    const l = local[p];
    const b = base[p];
    const s = server.files[p];
    // 两侧内容一致就是一致（基线可能是空的/过期的）；否则才看各自相对基线变了什么
    if (l && s && l.hash === s.hash) continue;
    const localDelta = (l?.hash ?? null) !== (b?.hash ?? null);
    const serverDelta = (s?.hash ?? null) !== (b?.hash ?? null);
    let status = "";
    if (localDelta && serverDelta) {
      status = "!";
      conflicts.push(p);
    } else if (localDelta) {
      status = l ? (b ? "M" : "A") : "D";
      push.push(p);
    } else if (serverDelta) {
      status = s ? (b ? "U" : "N") : "U";
      pull.push(p);
    } else {
      continue;
    }
    const size = l?.size ?? s?.size ?? 0;
    rows.push({ status, p, size: sizeText(size) });
  }

  if (opts.json) {
    console.log(
      JSON.stringify({
        ok: true,
        revision: server.revision,
        pending: { push, pull, conflicts },
      }),
    );
  } else {
    if (rows.length) printTable(rows);
    else console.log("一致：本地、基线与服务端三方相同。");
    console.log(
      `pending: push ${push.length} / pull ${pull.length} / conflict ${conflicts.length} ` +
        `(local revision ${state.revision}, server revision ${server.revision})`,
    );
  }
  return push.length || pull.length || conflicts.length ? 1 : 0;
}

export async function runPush(opts: ClientOpts): Promise<number> {
  const rules = loadFilters(opts.filters);
  const state = await loadState(opts);
  const local = await scanLocal(opts.root, rules);
  const base = state.manifest;

  const puts: { path: string; hash: string; size: number; data: string }[] = [];
  for (const [p, e] of Object.entries(local)) {
    if (base[p]?.hash === e.hash) continue;
    const bytes = new Uint8Array(await Bun.file(path.join(opts.root, p)).arrayBuffer());
    puts.push({ path: p, hash: e.hash, size: e.size, data: base64(bytes) });
  }
  const deletes = Object.keys(base).filter((p) => !(p in local));

  let res: PushResponse;
  try {
    res = await api<PushResponse>(opts, "/v1/push", {
      device: opts.device,
      dryRun: opts.dryRun === true,
      manifest: base,
      puts,
      deletes,
    });
  } catch (err) {
    console.error(String((err as Error).message));
    return 2;
  }

  for (const a of res.applied) {
    if (a.op === "put") {
      const e = local[a.path];
      if (e) state.manifest[a.path] = e;
    } else {
      delete state.manifest[a.path];
    }
  }
  if (!opts.dryRun) {
    state.revision = res.revision;
    await saveState(opts, state);
  }

  if (!opts.json) {
    for (const a of res.applied) console.log(`applied  ${a.op.padEnd(6)} ${a.path}`);
    for (const c of res.conflicts) console.log(`conflict ${c.path}  ${c.reason} savedAs=${c.savedAs ?? "-"}`);
    for (const s of res.skipped) console.log(`skipped  ${s.path}  ${s.reason}`);
    console.log(
      `applied ${res.applied.length} / conflict ${res.conflicts.length} / skipped ${res.skipped.length} ` +
        `(revision ${res.revision}${opts.dryRun ? ", dry-run" : ""})`,
    );
  } else {
    console.log(JSON.stringify({ ok: true, revision: res.revision, applied: res.applied, conflicts: res.conflicts, skipped: res.skipped }));
  }
  return res.conflicts.length || res.skipped.length ? 1 : 0;
}

export async function runPull(opts: ClientOpts): Promise<number> {
  const rules = loadFilters(opts.filters);
  const state = await loadState(opts);
  const local = await scanLocal(opts.root, rules);
  const base = state.manifest;
  const stamp = utcStamp();
  const dryRun = opts.dryRun === true;

  let res: PullResponse;
  try {
    res = await api<PullResponse>(opts, "/v1/pull", { device: opts.device, manifest: base });
  } catch (err) {
    console.error(String((err as Error).message));
    return 2;
  }

  const written: string[] = [];
  const conflicts: { path: string; savedAs: string }[] = [];
  const pruned: string[] = [];
  const kept: string[] = [];

  for (const put of res.puts) {
    const abs = path.join(opts.root, put.path);
    const bytes = new Uint8Array(Buffer.from(put.data, "base64"));
    const localEntry = local[put.path];
    if (localEntry && localEntry.hash !== base[put.path]?.hash) {
      const savedAs = `${put.path}.server-${stamp}`;
      if (!dryRun) await writeFileAtomic(path.join(opts.root, savedAs), bytes);
      conflicts.push({ path: put.path, savedAs });
      continue;
    }
    if (!dryRun) {
      await writeFileAtomic(abs, bytes);
      base[put.path] = { hash: put.hash, size: put.size };
    }
    written.push(put.path);
  }

  for (const p of res.removed) {
    const localEntry = local[p];
    if (!opts.prune) {
      kept.push(p);
      continue;
    }
    if (localEntry && localEntry.hash !== base[p]?.hash) {
      kept.push(p);
      continue;
    }
    if (!dryRun) {
      await fs.promises.rm(path.join(opts.root, p), { force: true });
      delete base[p];
    }
    pruned.push(p);
  }

  if (!dryRun) {
    state.revision = res.revision;
    await saveState(opts, state);
  }

  if (!opts.json) {
    for (const p of written) console.log(`written  ${p}`);
    for (const c of conflicts) console.log(`conflict ${c.path}  本地有未推送改动，服务端版本另存为 ${c.savedAs}`);
    for (const p of pruned) console.log(`pruned   ${p}`);
    for (const p of kept) {
      console.log(
        opts.prune
          ? `kept     ${p}  服务端已删除，本地有改动 → 保留`
          : `removed  ${p}  服务端已删除（本地未处理；带 --prune 可清理）`,
      );
    }
    console.log(
      `written ${written.length} / conflict ${conflicts.length} / pruned ${pruned.length} / kept ${kept.length} ` +
        `(revision ${res.revision}${dryRun ? ", dry-run" : ""})`,
    );
  } else {
    console.log(JSON.stringify({ ok: true, revision: res.revision, written, conflicts, pruned, kept }));
  }
  return conflicts.length || (opts.prune ? kept.length : 0) ? 1 : 0;
}
