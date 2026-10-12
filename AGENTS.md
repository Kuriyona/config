# AGENTS.md

本仓库 = 自带的配置同步工具 + 被它搬运的配置数据。**根目录只放代码与文档**，配置数据全在
`payload/`（gitignored）。读者定位：任何在本仓库里改代码/改配置/排错的 agent。

结构、快速开始、部署与故障处理见 `README.md`；线上契约见 `docs/protocol.md`。

## 硬规则

- **仓库内不得出现明文密钥。** `payload/agent/models.yml` 的 `apiKey` 写环境变量名
  （如 `MY_PROVIDER_API_KEY`），真值放本机 `~/.omp/agent/.env`（不在仓库、不在白名单）。
- **`payload/**` 是配置数据，不进 git。** 它由 `sync-filters.txt` 白名单 + 同步协议搬运；
  **不得 `git add -f payload/...`**，也不要往 `.gitignore` 里给它开洞。
- **改 `sync-filters.txt` 会同时改动服务端与所有设备的同步面**（它是两侧共用的一份）。
  加一行 = 所有未来 push/pull 都带上该路径；服务端重启即生效，客户端无需改。
- **提交前跑 `bun test` 与 `bun run typecheck`**，两者都必须干净。
- **机器专有键**只写 `payload/device.<hostname>.yml`（WSL 为带发行版后缀的名字），经
  `PI_CONFIG_FILES` 注入；不要用 `omp config set` 设它们（CLI 只写全局层，即被同步的那份）。
- 不跟踪：`.env`、`secrets.yml`、`*.db*`、`sessions/`、`logs/`、`cache/`、
  `terminal-sessions/`、`install-id`——要么含密钥，要么是机器状态。

## 代码约定

- 运行时零依赖：只用 `bun` 与 `node:*`；`bun install` 只为 `typecheck`（`typescript` + `@types/bun`）。
- 协议语义只写在 `src/core.ts`，客户端与服务端都 import 它，任何一侧另写一套都会造成两端不一致。
- 环境变量的唯一真源是 `.env.example`；实现与文档不得另立清单。
- 注释与文档用中文。

## payload 约定

`payload/` 布局：`agent/`（`~/.omp/agent` 的镜像）、`config/`（其他工具配置，不由 `link.mjs` 管理）、
`link.mjs`、`device.example.yml`、`device.<hostname>*.yml`（本机专有，gitignored）。

链接机制（`payload/link.mjs`，其路径全部相对自身解析；`REPO = dirname(link.mjs)/agent`）：

- 文件项 = 符号链接（Windows 需开发者模式）；目录项 = junction（Windows 无需管理员）。
- 无参数：首次把本机已有文件 **adopt** 进 `payload/agent` 后建链；两侧同名冲突时本机旧副本移到
  `~/.omp-sync-backup/<时间戳>/`，仓库版本胜出。`--check` 只读检查（未全链接退出码 1）；
  `--revert` 把仓库内容拷回 agent 目录并移除链接。
- 目录项（`skills`/`prompts`/…）**整体搬运，不逐文件合并**；动手前先跑 `--check`，它会把
  `diverged`、`adopt-pending`、`stale-link`、`foreign-link` 这类破坏性动作列出来。
- `foreign-link` = 该名字已指向仓库之外，脚本不会动它，需人工确认。
- 新增要同步的项：放进 `payload/agent/<位置>`（如 `skills/<name>/SKILL.md`），跑一次脚本。

覆盖层与环境：

- `PI_CONFIG_FILES` 指向 `<repo>/payload/device.<host>*.yml` 的绝对路径，优先级高于全局
  `config.yml` 与项目配置，且从不被同步；文件缺失或不是 YAML 映射会让 OMP 启动直接报错。
- 命名按环境区分：非 WSL 为 `device.<hostname>.yml`，WSL 为 `device.<hostname>.<发行版>.yml`
  （WSL 继承 Windows 的 hostname，不加后缀两边会抢同一个文件）。**两边各设各的
  `PI_CONFIG_FILES`**：Windows 用 `setx`，WSL 写进 `~/.bashrc`。该变量是平台路径列表
  （`;` Windows / `:` Unix），后者覆盖前者。
- `~/.omp/agent/.env`（明文密钥）不同步，每个环境各放一份。

其他：

- **换行一律 LF**（`.gitattributes` = `* text=auto eol=lf`）。不要写 `text=utf-8`：非法值，等价于
  无条件 `text`，会把二进制文件也做换行转换；`working-tree-encoding=UTF-8` 对 UTF-8 内容是空转，别加。
- `payload/agent/skills/<name>/SKILL.md` 是 OMP 原生 skill：只扫一层子目录，frontmatter 必须有
  `description`，否则 native provider 不加载。
- 本仓库自身的接入流程保存在 `payload/agent/skills/kuriyona-config-sync/SKILL.md`
  （`skill://kuriyona-config-sync`），改流程时两处一起改。
