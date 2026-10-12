# config-sync

自带的 OMP 配置同步工具。**仓库根只放代码与文档**；配置数据（`agent/**`、`config/**`、
`link.mjs`、`device.*.yml`）全部集中在 `payload/`，该目录整体不进 git，改由本项目的同步协议搬运。

同一个仓库在两个角色下运行：

- **服务端**：`bun src/server.ts`，持有权威副本 `data/`，PM2 一键守护。
- **客户端**：`bun src/cli.ts status|push|pull`，`SYNC_ROOT` 默认就是 `payload/`。

依赖：**bun ≥ 1.3**（运行时零依赖，只用 `bun` 与 `node:*`；`bun install` 只服务 `typecheck`）。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `src/core.ts` | 客户端/服务端共用纯逻辑：过滤器、路径安全、清单、原子写、归档、时间戳 |
| `src/server.ts` | 服务端：`/healthz`、`/v1/status`、`/v1/push`、`/v1/pull` |
| `src/client.ts` | 客户端逻辑：`runStatus` / `runPush` / `runPull` |
| `src/cli.ts` | 客户端入口：argv、环境变量、退出码 |
| `sync-filters.txt` | 同步白名单（两侧共用；改动等于改动**所有设备**的同步面） |
| `docs/protocol.md` | 线上契约：路由、判定表、错误码、冲突与归档落点 |
| `ecosystem.config.cjs` | PM2 配置（`bun run pm2`） |
| `.env.example` | 环境变量的唯一真源 |
| `payload/` | **配置数据**（不进 git）：`agent/`、`config/`、`link.mjs`、`device.*.yml` |
| `data/`、`history/`、`.sync-server/`、`.sync/` | 运行时（不进 git） |
| `test/e2e.test.ts` | `bun test`：起真实服务端/客户端子进程的端到端用例 |

## 快速开始

```bash
cp .env.example .env        # 改 SYNC_HOST / SYNC_PORT / SYNC_TOKEN（按需）
bun src/server.ts           # 服务端

bun src/cli.ts status       # 客户端：看差异（0 一致 / 1 有 pending / 2 错误）
bun src/cli.ts push         # 推本地改动
bun src/cli.ts pull         # 拉服务端改动（--prune 清理服务端已删的文件）
```

`bun test` 与 `bun run typecheck` 是提交前的两道闸。

## VPS 部署

```bash
git clone <本仓库> /srv/config-sync && cd /srv/config-sync   # 或 rsync 一份工作树过去
cp .env.example .env
# 在 .env 里设：SYNC_HOST、SYNC_PORT、SYNC_TOKEN=<随机串>、SYNC_DATA/SYNC_HISTORY/SYNC_STATE_DIR
bun add -g pm2          # 失败则 npm i -g pm2
bun run pm2             # = pm2 start ecosystem.config.cjs
pm2 save && pm2 startup # 开机自启
```

**三种暴露方式，差别只有 `SYNC_HOST`**：

| 方式 | `SYNC_HOST` | 说明 |
| --- | --- | --- |
| 只监听回环 + SSH 隧道 | `127.0.0.1` | 最安全；客户端 `ssh -L 8787:127.0.0.1:8787 <vps>` 后连 `http://127.0.0.1:8787` |
| 监听 Tailscale 地址 | tailscale IP | 组网内直连，不需要公网 |
| 反代终结 TLS | `127.0.0.1` | nginx/Caddy 反代到 `SYNC_PORT`，客户端用 `https://…` |

`SYNC_HOST` 非回环且 `SYNC_TOKEN` 为空时进程**启动即退出**（fail-fast）。

## 新设备接入

```bash
gh repo clone Kuriyona/config ~/config          # 或任意目录
cd ~/config && cp .env.example .env             # 填 SYNC_URL、SYNC_TOKEN（需要时）
bun src/cli.ts pull                             # 把服务端的 payload 拉到 ./payload
bun payload/link.mjs                            # 把 payload/agent 链接到 ~/.omp/agent
bun payload/link.mjs --check                    # 期望 "all items linked."、退出码 0
```

然后设机器覆盖层（见下），本机密钥写 `~/.omp/agent/.env`（不进仓库）。

## 链接用法（`payload/link.mjs`）

`link.mjs` 就在 `payload/` 内，它的全部路径都相对自身解析：`REPO = dirname(link.mjs)/agent`
（即 `payload/agent`），device 模板取自 `dirname(REPO)`（即 `payload/`）。

```bash
bun payload/link.mjs          # 建链接；首次会把本机已有文件 adopt 进 payload/agent
bun payload/link.mjs --check  # 只读检查，未全链接退出码 1
bun payload/link.mjs --revert # 把仓库内容拷回 agent 目录并移除链接
```

- 文件项 = 符号链接（Windows 需开发者模式）；目录项 = junction（Windows 无需管理员）。
- 两侧同名且内容不同 → 本机旧副本移到 `~/.omp-sync-backup/<时间戳>/`，仓库版本胜出。
- 会顺带生成 `payload/device.<hostname>.yml`（WSL 为 `device.<hostname>.<发行版>.yml`）。

**`PI_CONFIG_FILES` 指向 `<repo>/payload/device.<host>*.yml`**（WSL 见 `~/.bashrc`，Windows 用
`setx`）。覆盖层优先级高于全局 `config.yml`，且从不被同步；文件缺失会让 OMP 启动直接报错。

**从旧布局（仓库根下的 `agent/`）搬过来的设备**：把 `mv` 与重跑脚本连在同一条命令里执行，
中间那段时间链接是悬空的：

```bash
cd ~/config && mkdir -p payload && mv agent config link.mjs device.example.yml device.*.yml payload/ \
  && bun payload/link.mjs && sed -i 's#config/device\.#config/payload/device.#' ~/.bashrc
```

## 故障处理

| 症状 | 处理 |
| --- | --- |
| `error=unauthorized` | `SYNC_TOKEN` 与服务端不一致，或忘了设 |
| `state 属于 <旧 url>，当前 <新 url>` | 换了服务端；确认后删除 `<SYNC_STATE_DIR>/state.json` 重建基线（不删会在下次 push 凭空产生冲突） |
| push 报 `conflict … server-changed` | 服务端也有新版本；来件已存成 `<path>.conflict-<device>-<stamp>`（在服务端 `data/` 或 `.sync-server/conflicts/`），手工合并 |
| push 报 `skipped path-not-allowed` | 该路径不在 `sync-filters.txt` 白名单内 |
| pull 报 `conflict … 本地有未推送改动` | 服务端版本另存为 `<path>.server-<stamp>`；先合并再 push |
| 要回滚服务端的覆盖/删除 | 归档在服务端 `history/<stamp>/<path>`，拷回来即可（客户端不留历史） |
| `error=too-large` | 单次请求体超过 32 MiB；把大文件移出 payload 白名单 |

## 许可

私有仓库。
