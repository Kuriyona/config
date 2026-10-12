/**
 * e2e.test.ts — 真实子进程端到端：起 bun src/server.ts，用 bun src/cli.ts 驱动客户端。
 * 全部状态落在 os.tmpdir() 下的临时目录，不污染仓库。
 */
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSafePath, hashBytes, loadFilters, matchFilters } from "../src/core.ts";

const REPO = path.resolve(import.meta.dir, "..");
const FILTERS = path.join(REPO, "sync-filters.txt");
const RULES = loadFilters(FILTERS);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-sync-e2e-"));
const dataDir = path.join(tmp, "data");
const historyDir = path.join(tmp, "history");
const serverState = path.join(tmp, "srv-state");

const ALLOWED: Record<string, string> = {
  "agent/config.yml": "v1\n",
  "agent/models.yml": "m1\n",
  "agent/skills/x/SKILL.md": "---\ndescription: x\n---\nbody\n",
  "agent/extensions/plugin.ts": "export const a = 1;\n",
  "link.mjs": "// link\n",
  "device.example.yml": "shellPath: /bin/bash\n",
};
const EXCLUDED: Record<string, string> = {
  "device.Kuriyona-ITX.yml": "shellPath: x\n",
  ".env": "SECRET=1\n",
  "data/x.txt": "nope\n",
  "config/oxfmt/oxfmtrc.json": "{}\n",
  "src/server.ts": "nope\n",
  "README.md": "nope\n",
};

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

type Server = { proc: Bun.Subprocess; url: string; stderr: () => Promise<string>; stop: () => void };

async function startServer(env: Record<string, string>): Promise<Server> {
  const proc = Bun.spawn(["bun", path.join(REPO, "src/server.ts")], {
    cwd: os.tmpdir(),
    env: { ...process.env, ...env } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let url = "";
  while (!url) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const obj = JSON.parse(line) as { msg?: string; url?: string };
        if (obj.msg === "listening" && obj.url) url = obj.url;
      } catch {}
      nl = buf.indexOf("\n");
    }
  }
  let stderrText = "";
  const stderrPromise = new Response(proc.stderr).text().then((t) => (stderrText = t));
  void (async () => {
    try {
      // 持续抽干 stdout，避免管道写满阻塞服务端
      while (!(await reader.read()).done);
    } catch {}
  })();
  return {
    proc,
    url,
    stderr: async () => {
      await stderrPromise;
      return stderrText;
    },
    stop: () => proc.kill(),
  };
}

async function runCli(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", path.join(REPO, "src/cli.ts"), ...args], {
    cwd: os.tmpdir(),
    env: { ...process.env, SYNC_FILTERS: FILTERS, ...env } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

function clientEnv(root: string, stateDir: string, url: string, device: string): Record<string, string> {
  return { SYNC_ROOT: root, SYNC_STATE_DIR: stateDir, SYNC_URL: url, SYNC_DEVICE: device };
}

function readState(stateDir: string) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")) as {
    revision: number;
    manifest: Record<string, { hash: string; size: number }>;
  };
}

const sha = (s: string) => hashBytes(new TextEncoder().encode(s));
const listFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string, pre: string) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = pre ? `${pre}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), rel);
      else out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
};

let server: Server;

afterAll(() => {
  server?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("config-sync e2e", () => {
  test("1. 过滤器允许/拒绝语义", () => {
    expect(matchFilters(RULES, "/agent/config.yml")).toBe(true);
    expect(matchFilters(RULES, "/agent/skills/x/SKILL.md")).toBe(true);
    expect(matchFilters(RULES, "/agent/extensions/plugin.ts")).toBe(true);
    expect(matchFilters(RULES, "/link.mjs")).toBe(true);
    expect(matchFilters(RULES, "/device.example.yml")).toBe(true);
    expect(matchFilters(RULES, "device.Kuriyona-ITX.yml")).toBe(false);
    expect(matchFilters(RULES, "/.env")).toBe(false);
    expect(matchFilters(RULES, "/data/x.txt")).toBe(false);
    expect(matchFilters(RULES, "/src/server.ts")).toBe(false);
    expect(matchFilters(RULES, "/config/oxfmt/oxfmtrc.json")).toBe(false);
    expect(() => assertSafePath("../evil")).toThrow("bad-request");
    expect(() => assertSafePath("/abs")).toThrow("bad-request");
  });

  test("2. push 落盘 + 基线 revision", async () => {
    server = await startServer({ SYNC_DATA: dataDir, SYNC_HISTORY: historyDir, SYNC_STATE_DIR: serverState, SYNC_PORT: "0" });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const rootA = path.join(tmp, "A");
    writeTree(rootA, { ...ALLOWED, ...EXCLUDED });
    const stateA = path.join(tmp, "A-state");
    const res = await runCli(["push"], clientEnv(rootA, stateA, server.url, "device-a"));
    expect(res.err).toBe("");
    expect(res.code).toBe(0);
    expect(res.out).toContain(`applied ${Object.keys(ALLOWED).length} / conflict 0 / skipped 0`);

    for (const [rel, content] of Object.entries(ALLOWED)) {
      const onServer = fs.readFileSync(path.join(dataDir, rel), "utf8");
      expect(onServer).toBe(content);
      expect(sha(onServer)).toBe(sha(content));
    }
    for (const rel of Object.keys(EXCLUDED)) {
      expect(fs.existsSync(path.join(dataDir, rel))).toBe(false);
    }
    expect(readState(stateA).revision).toBe(1);
  });

  test("3. pull 复刻服务端文件集合与内容", async () => {
    const deviceB = path.join(tmp, "B-root");
    fs.mkdirSync(deviceB, { recursive: true });
    const res = await runCli(["pull"], clientEnv(deviceB, path.join(tmp, "B-state"), server.url, "device-b"));
    expect(res.code).toBe(0);
    expect(listFiles(deviceB).filter((f) => !f.startsWith(".sync"))).toEqual(Object.keys(ALLOWED).sort());
    for (const [rel, content] of Object.entries(ALLOWED)) {
      expect(fs.readFileSync(path.join(deviceB, rel), "utf8")).toBe(content);
    }
  });

  test("4. 冲突：服务端保持新内容，来件另存且本地不动", async () => {
    const rootA = path.join(tmp, "A");
    const stateA = path.join(tmp, "A-state");
    const rootB = path.join(tmp, "B-root");
    const stateB = path.join(tmp, "B-state");

    fs.writeFileSync(path.join(rootB, "agent/config.yml"), "B\n");
    const pushB = await runCli(["push"], clientEnv(rootB, stateB, server.url, "device-b"));
    expect(pushB.code).toBe(0);
    expect(fs.readFileSync(path.join(dataDir, "agent/config.yml"), "utf8")).toBe("B\n");

    fs.writeFileSync(path.join(rootA, "agent/config.yml"), "A\n");
    const pushA = await runCli(["push"], clientEnv(rootA, stateA, server.url, "device-a"));
    expect(pushA.code).toBe(1);
    expect(pushA.out).toContain("conflict agent/config.yml  server-changed");

    const saved = listFiles(dataDir).filter((f) => f.startsWith("agent/config.yml.conflict-"));
    expect(saved.length).toBe(1);
    expect(fs.readFileSync(path.join(dataDir, saved[0]!), "utf8")).toBe("A\n");
    expect(fs.readFileSync(path.join(dataDir, "agent/config.yml"), "utf8")).toBe("B\n");
    expect(fs.readFileSync(path.join(rootA, "agent/config.yml"), "utf8")).toBe("A\n");
    // 冲突不动基线：仍是 v1 的哈希，便于下次重新检出
    expect(readState(stateA).manifest["agent/config.yml"]!.hash).toBe(sha("v1\n"));
  });

  test("5. 删除 + 归档 + pull/--prune/保留", async () => {
    const rootA = path.join(tmp, "A");
    const stateA = path.join(tmp, "A-state");
    const rootC = path.join(tmp, "C-root");
    const stateC = path.join(tmp, "C-state");
    const rootD = path.join(tmp, "D-root");
    const stateD = path.join(tmp, "D-state");
    fs.mkdirSync(rootC, { recursive: true });
    fs.mkdirSync(rootD, { recursive: true });

    // C 与 D 先各拉一份完整副本（此时 models.yml 还在）
    expect((await runCli(["pull"], clientEnv(rootC, stateC, server.url, "device-c"))).code).toBe(0);
    expect((await runCli(["pull"], clientEnv(rootD, stateD, server.url, "device-d"))).code).toBe(0);
    fs.writeFileSync(path.join(rootD, "agent/models.yml"), "d-local\n");

    // A 采用服务端版本，先解决 test 4 留下的冲突
    fs.writeFileSync(path.join(rootA, "agent/config.yml"), "B\n");
    const resolved = await runCli(["push"], clientEnv(rootA, stateA, server.url, "device-a"));
    expect(resolved.code).toBe(0);

    // A 删除 models.yml 并推送
    fs.rmSync(path.join(rootA, "agent/models.yml"));
    const del = await runCli(["push"], clientEnv(rootA, stateA, server.url, "device-a"));
    expect(del.code).toBe(0);
    expect(del.out).toContain("applied  delete agent/models.yml");
    expect(fs.existsSync(path.join(dataDir, "agent/models.yml"))).toBe(false);

    const archived = fs
      .readdirSync(historyDir)
      .map((s) => path.join(historyDir, s, "agent/models.yml"))
      .filter((p) => fs.existsSync(p));
    expect(archived.length).toBe(1);
    expect(fs.readFileSync(archived[0]!, "utf8")).toBe("m1\n");

    // C：不 prune 只报告
    const cReport = await runCli(["pull"], clientEnv(rootC, stateC, server.url, "device-c"));
    expect(cReport.out).toContain("removed  agent/models.yml");
    expect(fs.existsSync(path.join(rootC, "agent/models.yml"))).toBe(true);

    // C：--prune 删除本地未改过的文件
    const cPrune = await runCli(["pull", "--prune"], clientEnv(rootC, stateC, server.url, "device-c"));
    expect(cPrune.code).toBe(0);
    expect(fs.existsSync(path.join(rootC, "agent/models.yml"))).toBe(false);
    expect(readState(stateC).manifest["agent/models.yml"]).toBeUndefined();

    // D：本地有改动 → 保留并报冲突
    const dPrune = await runCli(["pull", "--prune"], clientEnv(rootD, stateD, server.url, "device-d"));
    expect(dPrune.code).toBe(1);
    expect(dPrune.out).toContain("服务端已删除，本地有改动 → 保留");
    expect(fs.readFileSync(path.join(rootD, "agent/models.yml"), "utf8")).toBe("d-local\n");
  });

  test("6. 鉴权：401 / 错 token / 正确 token", async () => {
    const authState = path.join(tmp, "auth-state");
    const secured = await startServer({
      SYNC_DATA: path.join(tmp, "auth-data"),
      SYNC_HISTORY: path.join(tmp, "auth-history"),
      SYNC_STATE_DIR: authState,
      SYNC_PORT: "0",
      SYNC_TOKEN: "t",
    });
    try {
      const bare = await fetch(`${secured.url}/v1/status`);
      expect(bare.status).toBe(401);
      const wrong = await fetch(`${secured.url}/v1/status`, { headers: { authorization: "Bearer nope" } });
      expect(wrong.status).toBe(401);
      const ok = await fetch(`${secured.url}/v1/status`, { headers: { authorization: "Bearer t" } });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { ok: boolean }).ok).toBe(true);
      const health = await fetch(`${secured.url}/healthz`);
      expect(health.status).toBe(200);
      expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
    } finally {
      secured.stop();
    }
  });

  test("7. 路径安全：bad-request / path-not-allowed 且不落盘", async () => {
    const body = {
      device: "device-e",
      dryRun: false,
      manifest: {},
      puts: [
        { path: "../evil", hash: sha("evil"), size: 4, data: Buffer.from("evil").toString("base64") },
        {
          path: "src/server.ts",
          hash: sha("nope\n"),
          size: 5,
          data: Buffer.from("nope\n").toString("base64"),
        },
      ],
      deletes: [],
    };
    const resp = await fetch(`${server.url}/v1/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await resp.json()) as { ok: boolean; skipped: { path: string; reason: string }[] };
    expect(resp.status).toBe(200);
    expect(json.skipped).toEqual([
      { path: "../evil", reason: "bad-request" },
      { path: "src/server.ts", reason: "path-not-allowed" },
    ]);
    expect(fs.existsSync(path.join(dataDir, "src/server.ts"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "evil"))).toBe(false);
  });

  test("8. fail-fast：非回环且无 token 时退出码 1", async () => {
    const proc = Bun.spawn(["bun", path.join(REPO, "src/server.ts")], {
      cwd: os.tmpdir(),
      env: {
        ...process.env,
        SYNC_HOST: "0.0.0.0",
        SYNC_TOKEN: "",
        SYNC_DATA: path.join(tmp, "ff-data"),
        SYNC_HISTORY: path.join(tmp, "ff-history"),
        SYNC_STATE_DIR: path.join(tmp, "ff-state"),
      } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(1);
    expect(err).toContain("非回环");
  });
});
