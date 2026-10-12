# 同步协议

客户端与服务端之间的线上契约。实现在 `src/core.ts`（共用语义）、`src/server.ts`（服务端）、
`src/client.ts`（客户端）。

## 通用

- 传输：HTTP/1.1 + JSON。`Content-Type: application/json`。
- 鉴权：`SYNC_TOKEN` 非空时校验 `Authorization: Bearer <token>`（定长异或比较）；失败
  `401 {"ok":false,"error":"unauthorized"}`。`SYNC_TOKEN` 为空（仅回环）时跳过。
- JSON 解析失败 → `400 {"ok":false,"error":"bad-request"}`。
- 请求体超过 32 MiB（`maxRequestBodySize`）→ `413 {"ok":false,"error":"too-large"}`。
- 未匹配的路由 → `404 {"ok":false,"error":"not-found"}`。
- 路径一律为 POSIX 相对路径，相对各自的根解析：客户端 = `SYNC_ROOT`，服务端 = `SYNC_DATA`。
- **并发模型：无全局锁。** 每个文件按「服务端现值 vs 客户端基线 vs 来件」三方比较独立收敛；
  较新者留在原文件名，落败者存成冲突副本。因此不需要「谁先谁后」的调度约定。

## 过滤器（`sync-filters.txt`）

- 只有两种模式：`/a/b/c` 精确路径、`/a/b/**` 目录下全部（递归）。
- 行首 `+` 允许 / `-` 拒绝；空行与 `#` 开头为注释；其它行 → 加载即报错（带行号）。
- **最后一条匹配的规则生效**；无任何规则匹配 = 不允许（允许清单语义）。
- 裸 `**`（如文件末尾的 `- **`）是兜底规则：只作用于前面所有规则都没匹配到的路径。
- 前导 `/` 与路径分隔统一为 `/`。

## 路径安全（`assertSafePath`）

拒绝：空串、以 `/` 开头、含 `..` 段、含反斜杠、含 NUL、长度 > 512、以 `/` 结尾。
违规在 push 里记 `skipped:{path,reason:"bad-request"}`（HTTP 仍 200）。

## `GET /healthz`（无鉴权）

`200 {"ok":true,"uptime":<秒>}`。不泄露任何数据，供 PM2 / 探活。

## `GET /v1/status`

`200 {"ok":true,"revision":<int>,"updatedAt":"<ISO>","files":{"<path>":{"hash":"<sha256hex>","size":<int>}}}`。
`files` 是服务端当前权威清单。

## `POST /v1/push`

请求：

```json
{"device":"kuriyona-itx-ubuntu","dryRun":false,
 "manifest":{"agent/config.yml":{"hash":"<sha256hex>","size":123}},
 "puts":[{"path":"agent/config.yml","hash":"<sha256hex>","size":123,"data":"<base64>"}],
 "deletes":["agent/old.md"]}
```

`manifest` 是**客户端的基线**（上次与服务端一致时的清单）。逐条判定中：
`serverHash` = 服务端当前值或 `null`；`baseHash` = `manifest[path]?.hash ?? null`。

### puts 判定表

| 情形 | 结果 |
| --- | --- |
| `assertSafePath` 失败 | `skipped:{path,reason:"bad-request"}` |
| 路径不在过滤器内 | `skipped:{path,reason:"path-not-allowed"}` |
| `hashBytes(data)` ≠ 声明的 `hash` | `skipped:{path,reason:"hash-mismatch"}`，不落盘 |
| `serverHash === null` | 归档旧值（无则跳过）→ 原子写 → `applied:{path,op:"put"}` |
| `serverHash === baseHash` | 同上（快进） |
| `serverHash === 声明的新 hash` | `applied:{path,op:"put"}`（内容已一致，不写盘） |
| 其它 | **冲突**：服务端文件不动，来件存成 `conflicts[].savedAs`，理由 `server-changed`，附 `serverHash` |

### deletes 判定表

| 情形 | 结果 |
| --- | --- |
| `serverHash === baseHash` | 归档 → 删除 → `applied:{path,op:"delete"}` |
| `serverHash !== baseHash` | `conflicts:[{path,reason:"base-mismatch",serverHash,savedAs:null}]`（不删） |
| `serverHash === null` | `applied:{path,op:"delete"}`（服务端已无此文件） |

deletes 同样先过 `assertSafePath` 与过滤器，违规记 `skipped`。

### 冲突副本落点

候选路径 `<path>.conflict-<device>-<stamp>`：

- 若该候选路径**能通过过滤器** → 写入 `SYNC_DATA`（于是进清单、其它设备 pull 得到，双方都能看到旧版本）；
  `savedAs` 为该相对路径。
- 否则 → 写入 `<SYNC_STATE_DIR>/conflicts/<stamp>-<device>/<path>`；`savedAs` 为该绝对路径。

`device` 过滤为 `[A-Za-z0-9._-]`（同 `core.deviceId` 的合法化规则），`stamp` 为 `utcStamp()`
（毫秒精度，`2026-10-13T02-31-20-123Z`）。

### dryRun

`dryRun:true` 时完整走判定与响应，但**不写任何文件**（`applied` 照实报告，`savedAs` 为 `null`）。

### 落盘顺序与 revision

每一步失败都不得留下半个状态：写数据文件（原子）→ 写冲突副本（原子）→
`writeManifestAtomic(<state>/manifest.json)` → `Bun.write(<state>/revision, String(revision + 1))`。

`revision` 仅在本次 push 实际改动了 `SYNC_DATA`（写了数据文件、删除、或写了落在 `SYNC_DATA` 的
冲突副本）时 `+1`；纯 dryRun 或全部冲突/跳过时不变。

响应 `200 {"ok":true,"revision":<递增后>,"applied":[…],"conflicts":[…],"skipped":[…]}`。

## `POST /v1/pull`

请求 `{"device":"…","manifest":{…}}`（`manifest` 为客户端基线）。响应：

```json
{"ok":true,"revision":123,
 "puts":[{"path":"agent/config.yml","hash":"<sha256hex>","size":123,"data":"<base64>"}],
 "removed":["agent/old.md"]}
```

- `puts` = 服务端每个 `manifest[path]?.hash !== entry.hash` 的文件（含客户端从没见过的）。
- `removed` = 客户端 manifest 里服务端已不存在的路径。
- pull **只读**，不做任何写盘。

## 客户端行为

- 状态文件 `<SYNC_STATE_DIR>/state.json`（原子写）：
  `{"version":1,"device":"…","url":"http://…","revision":0,"lastSyncAt":"<ISO>","manifest":{…}}`。
  `url` 与当前 `SYNC_URL` 不一致 → 打印提示并 `exit 2`（不静默沿用旧基线）。
- **status**：本地扫描 + 哈希 + `GET /v1/status`，六分类：
  `A` 本地新增 / `M` 本地已改 / `D` 本地已删（三者 = 待 push）；
  `N` 服务端新增 / `U` 服务端已改（含服务端删除；两者 = 待 pull）；
  `!` 双侧都改（冲突，需手工合并）。其余为一致。
  汇总行 `pending: push <n> / pull <n> / conflict <n> (local revision <a>, server revision <b>)`。
  `--json` → `{"ok":true,"revision":<服务端>,"pending":{"push":[…],"pull":[…],"conflicts":[…]}}`。
  退出码：0 一致 / 1 有 pending 或冲突 / 2 错误。
- **push**：扫描 → 与 `state.manifest` 比较得 puts（新增或哈希变了）与 deletes（在基线里但磁盘没了）
  → `POST /v1/push` → 把 `applied` 写回 `state.manifest` 并保存 `revision`；
  **冲突/跳过条目不动基线**（保持旧 base，便于下次重新检出）。
  退出码：0 全部 applied / 1 有 conflict 或 skipped / 2 错误。
- **pull**：`POST /v1/pull` → 对每个 put：若本地已存在且 `hash != state.manifest[path]?.hash`
  （本地有未推送改动）→ 不覆盖，把服务端内容存成 `<path>.server-<stamp>` 并提示手工合并；
  否则原子写入并更新基线。对每个 removed：`--prune` 且本地哈希等于基线哈希 → 删除并同步删除基线条目；
  否则保留并提示 `服务端已删除，本地有改动 → 保留`；不带 `--prune` 只报告。
  客户端不建自己的历史目录（删除是「服务端已归档过的那份」，回滚走服务端 `history/`）。
  退出码：0 全部写入 / 1 有冲突或被保留的删除 / 2 错误。
- 网络失败 / 非 2xx → `error=<code> detail=<...>`，`exit 2`；超时 `AbortSignal.timeout(15_000)`。

## 环境变量

唯一真源是 `.env.example`；实现不得另立清单。
