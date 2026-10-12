/**
 * core.ts — 客户端与服务端共用的纯逻辑。
 *
 * 这里是协议语义的唯一实现：过滤器、路径安全、清单、原子写、归档、时间戳、设备名、
 * 定长比较、结构化日志。两侧都 import 本模块，任何偏离都会造成两端不一致。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Manifest = Record<string, { hash: string; size: number }>;
/** pattern 以 / 结尾表示目录递归；catchAll 表示 `/a/**` 之外的裸 `**` 兜底规则。 */
export type FilterRule = { allow: boolean; pattern: string; prefix: boolean; catchAll: boolean };

/** 过滤器语法：`+ /a/b` 允许、`- /a/b` 拒绝，`/a/b/**` 表示目录下全部（递归）；最后匹配者生效。 */
export function loadFilters(file: string): FilterRule[] {
  const text = fs.readFileSync(file, "utf8");
  const rules: FilterRule[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    const m = /^([+-])\s*(\S.*)$/.exec(raw);
    if (!m) throw new Error(`filters: 第 ${i + 1} 行无法解析: ${raw}`);
    const allow = m[1] === "+";
    let p = m[2].trim().replace(/\\/g, "/");
    if (p === "**" || p === "/**") {
      // 兜底规则：只作用于前面所有规则都没匹配到的路径（默认即拒绝，故 `- **` 是无害的收尾）
      rules.push({ allow, pattern: "**", prefix: false, catchAll: true });
      continue;
    }
    if (!p.startsWith("/")) throw new Error(`filters: 第 ${i + 1} 行必须以 / 开头: ${raw}`);
    if (p.endsWith("/**")) {
      const base = p.slice(0, -2); // 保留末尾斜杠，例如 "/agent/**" -> "/agent/"
      if (!base.endsWith("/")) throw new Error(`filters: 第 ${i + 1} 行语法无效: ${raw}`);
      rules.push({ allow, pattern: base, prefix: true, catchAll: false });
      continue;
    }
    if (p.endsWith("/")) throw new Error(`filters: 第 ${i + 1} 行不能以 / 结尾: ${raw}`);
    rules.push({ allow, pattern: p, prefix: false, catchAll: false });
  }
  return rules;
}

/** 最后一条匹配的正常规则生效；兜底 `**` 只在前面都没匹配到时生效；全不匹配 = 不允许。 */
export function matchFilters(rules: FilterRule[], relPath: string): boolean {
  let rel = relPath.replace(/\\/g, "/");
  if (!rel.startsWith("/")) rel = "/" + rel;
  let result = false;
  let anyMatched = false;
  for (const r of rules) {
    if (r.catchAll) {
      if (!anyMatched) result = r.allow;
      anyMatched = true;
      continue;
    }
    const hit = r.prefix ? rel.startsWith(r.pattern) : rel === r.pattern;
    if (hit) {
      result = r.allow;
      anyMatched = true;
    }
  }
  return result;
}

/** 允许集合的前缀，供扫描剪枝用；含 "" 表示允许一切。 */
export function allowedPrefixes(rules: FilterRule[]): string[] {
  const out = new Set<string>();
  for (const r of rules) {
    if (!r.allow) continue;
    if (r.catchAll) return [""];
    const p = r.pattern.replace(/^\//, "").replace(/\/$/, "");
    if (p) out.add(p);
  }
  return [...out];
}

/** 拒绝空串、绝对路径、`..` 段、反斜杠、NUL、超长、目录结尾；违规抛 Error("bad-request")。 */
export function assertSafePath(relPath: string): void {
  if (typeof relPath !== "string" || relPath.length === 0) throw new Error("bad-request");
  if (relPath.length > 512) throw new Error("bad-request");
  if (relPath.startsWith("/")) throw new Error("bad-request");
  if (relPath.endsWith("/")) throw new Error("bad-request");
  if (relPath.includes("\\")) throw new Error("bad-request");
  if (relPath.includes("\0")) throw new Error("bad-request");
  if (relPath.split("/").some((seg) => seg === "..")) throw new Error("bad-request");
}

export async function listPayloadFiles(root: string, rules: FilterRule[]): Promise<string[]> {
  const prefixes = allowedPrefixes(rules);
  const allowAll = prefixes.includes("");
  const out: string[] = [];
  const walk = (relDir: string): void => {
    const abs = relDir ? path.join(root, relDir) : root;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue; // 跳过符号链接，避免走出 payload
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        // 进入可能是允许路径前缀的目录（允许前缀本身，或允许前缀在它之下）
        if (allowAll || prefixes.some((p) => p === rel || p.startsWith(rel + "/") || rel.startsWith(p + "/"))) {
          walk(rel);
        }
      } else if (ent.isFile()) {
        if (matchFilters(rules, "/" + rel)) out.push(rel);
      }
    }
  };
  walk("");
  out.sort();
  return out;
}

export function hashBytes(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export async function hashFile(abs: string): Promise<{ hash: string; size: number }> {
  const buf = new Uint8Array(await Bun.file(abs).arrayBuffer());
  return { hash: hashBytes(buf), size: buf.byteLength };
}

export async function readManifest(file: string): Promise<Manifest> {
  try {
    const text = await Bun.file(file).text();
    const parsed = JSON.parse(text) as Manifest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeFileAtomic(abs: string, data: Uint8Array): Promise<void> {
  const dir = path.dirname(abs);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.tmp-${crypto.randomUUID().slice(0, 8)}`);
  await Bun.write(tmp, data);
  await fs.promises.rename(tmp, abs);
}

export async function writeManifestAtomic(file: string, manifest: Manifest): Promise<void> {
  const text = JSON.stringify(manifest, null, 2) + "\n";
  await writeFileAtomic(file, new TextEncoder().encode(text));
}

/** 把 abs 复制到 <historyRoot>/<stamp>/<relPath>；源不存在返回 null；返回归档后的绝对路径。 */
export async function archiveFile(
  abs: string,
  relPath: string,
  historyRoot: string,
  stamp: string,
): Promise<string | null> {
  if (!fs.existsSync(abs)) return null;
  const dest = path.join(historyRoot, stamp, relPath);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.promises.copyFile(abs, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EXDEV") {
      await Bun.write(dest, Bun.file(abs));
    } else {
      throw err;
    }
  }
  return dest;
}

/** 2026-10-13T02-31-20-123Z（把 ISO 里的冒号与点换成 -） */
export function utcStamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

/** SYNC_DEVICE → hostname，WSL 追加 -<发行版小写>，结果过滤为 [A-Za-z0-9._-]。 */
export function deviceId(): string {
  let name = process.env.SYNC_DEVICE?.trim() || os.hostname();
  const distro = process.env.WSL_DISTRO_NAME?.trim();
  if (distro) name = `${name}-${distro.toLowerCase()}`;
  const tag = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return tag || "unknown";
}

/** 定长异或比较，避免短路比较泄露前缀；不使用 node:crypto。 */
export function safeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

const LOG_ORDER = ["level", "msg"];

/** 单行 JSON 到 stdout，字段序固定（level/msg 在前，其余按插入序）。 */
export function logLine(obj: Record<string, unknown>): void {
  const out: Record<string, unknown> = {};
  for (const k of LOG_ORDER) if (k in obj) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!LOG_ORDER.includes(k)) out[k] = obj[k];
  console.log(JSON.stringify(out));
}
