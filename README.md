# AI TVC Agent（本地桌面应用）

一条可审查、可局部修改、可追溯的 TVC 生产流程：

`Brief → AI 复述确认 → 三条创意方向 → 结构化脚本 → 逐镜静态分镜 → 视频生成`

Electron 桌面应用，本地优先：项目就是磁盘上的一个文件夹，视频落盘后不依赖任何远程链接。
视频与图片经 ORZ 网关生成（**不使用 fal.ai**，原因见 `docs/decisions/0001-video-backend.md`）。

---

## 在新电脑上跑起来

### 0. 先装对 bun 的版本

**必须 bun ≥ 1.4.0。** 本仓库的 `bun.lock` 是 lockfileVersion 2，
旧版 bun 会直接报 `error: Unknown lockfile version` 并停在第一步。

```bash
bun --version          # 必须 >= 1.4.0
curl -fsSL https://bun.sh/install | bash    # 没装或版本过低就跑这句
```

装完新开一个终端，或 `source ~/.zshrc`，确认 `which bun` 指向新版本。
若系统里有多个 bun（`~/.bun/bin/bun` 与 Homebrew 的），以 `which bun` 实际解析到的为准。

### 1. 装依赖

```bash
git clone https://github.com/fayezang/ai-tvc-agent.git
cd ai-tvc-agent
bun install
```

只保留 `bun.lock` 一份锁文件，不要用 npm / pnpm。
`postinstall` 会自动执行 `electron-builder install-app-deps`，把 `better-sqlite3`
按 Electron 的 ABI 重新编译——这一步不能跳过。

### 2. 先跑测试确认代码没问题

```bash
bun test tests        # 应为 120 pass / 0 fail
bun run typecheck     # 应无输出
```

**先跑这两条再启动应用。** 全过就说明代码是好的；
之后 `dev` 若仍起不来，那是环境问题（见下），不必怀疑代码。

### 3. 启动

```bash
bun run dev
```

Electron 窗口会自己打开，**不是浏览器页面**，没有 localhost 端口。

### 4. 填 API Key

首次使用在应用内「模型与 API」界面录入 ORZ API Key（<https://orz.sh>）。

Key 经 `safeStorage` 加密后存进系统钥匙串，**不写任何文件**，Renderer 进程也读不到。
所以 Key 不会跟着 git 走，**每台新电脑都要重新录一次**——这是设计如此，不是遗漏。

`.env.example` 只是可配置项清单，正常使用不需要 `.env` 文件。

---

## 迁移已有的项目数据

代码与项目数据是分开的：**仓库里没有任何项目内容**。

一个项目就是磁盘上任意位置的一个文件夹，自包含：

```
我的项目/
├── project.json          项目元数据（时长、画幅）
├── canvas.json           画布节点与连线
├── nodes/*.md            Brief、创意、脚本正文
├── assets/
│   ├── videos/           已落盘的视频（第一批起不再依赖远程链接）
│   ├── storyboards/      分镜图
│   └── references/       参考图
├── outputs/              导出成品（第四批启用）
└── .agent/
    ├── index.sqlite      节点索引与视频任务记录
    └── trash/            删除节点时移入这里，非直接销毁
```

**整个文件夹拷到新电脑即可**，用应用内「打开已有项目」选中它。
`.agent/index.sqlite` 会在打开时自动执行 migration 补齐新版本的表和列，
旧项目不需要任何手工处理。

拷贝时务必**连 `.agent/` 一起带上**（点开头的隐藏目录，
Finder 里按 `Cmd+Shift+.` 显示）。丢了它会丢掉视频任务记录。

**不要迁移 API Key**：旧机钥匙串里的内容无法也不应导出，在新机器重新录一次。


---

## 常用命令

```bash
bun run dev        # 开发模式，打开 Electron 窗口
bun run typecheck  # tsc 双配置检查（node 侧 + web 侧）
bun test tests     # 全量测试
bun run dist       # 打包 macOS 安装包到 dist/
```

`bun run build` 会先跑 typecheck 再构建，类型不过就不会产出。

---

## 已知环境问题

**症状**：`bun run dev` 报 `library load disallowed by system policy`
或 `Cannot find module '../lightningcss.darwin-arm64.node'`。

**原因**：macOS 代码签名策略拦截了 rollup / esbuild / lightningcss 的原生模块。
这是**机器环境问题，不是代码问题**——同一份代码在没有该策略的机器上正常运行。

**影响范围**：只影响 `dev` 与 `build`。`bun test` 与 `typecheck` 不受影响，
因为测试用 `bun:sqlite` 而非 better-sqlite3（见下）。

**排查**：先确认是不是这个原因，再决定要不要动代码。

```bash
node -e "require('lightningcss-darwin-arm64')" 2>&1 | head -3
```

出现 `disallowed by system policy` 即可确认。

---

## 测试为什么用 bun:sqlite

生产代码在 Electron 内用 `better-sqlite3`，但它的原生模块由
`electron-builder install-app-deps` 按 Electron ABI 编译，
**在 bun / node 下加载即崩溃（SIGKILL / Exit 137）**，无法用于测试。

因此 `runMigrations` 与 `JobService` 都接受最小数据库接口而非具体驱动，
测试注入同为真实 SQLite 引擎的 `bun:sqlite`。

测试不 mock：用 `Bun.serve` 起真实 HTTP 服务，用 `mkdtemp` 用真实目录，
MP4 头字节取自标准容器。

---

## 项目结构

Electron 真实运行的代码只有这五个目录：

```
src/
├── main/       主进程：窗口、IPC 注册、钥匙串
├── preload/    上下文桥接（含 IPC 事件白名单）
├── renderer/   React 界面：画布、Agent 面板
├── shared/     三进程共用的 Schema、状态机、IPC 频道名
└── utility/    Utility Process：项目、Agent、视频任务、数据库
```

数据库变更**必须**在 `src/utility/migrations.ts` 追加新条目，
不要修改已发布的条目——已升级过的库不会重跑它们。

---

## 文档

| 文件 | 内容 |
|---|---|
| `docs/decisions/0001-video-backend.md` | 为何用 ORZ 而非 CutAgent / fal.ai；ffmpeg 命令序列存档 |
| `docs/decisions/0002-project-entry-points.md` | 为何首次进入只有两个入口 |
| `docs/BATCH-2-KICKOFF.md` | 第二批（任务可靠性）的范围与验收 |
| `docs/BATCH-3-KICKOFF.md` | 第三批（成本可见与提交前确认）的范围与验收 |
| `docs/BATCH-4-KICKOFF.md` | 第四批（导出与交片）的范围与验收 —— **下一批从这里开始** |
| `docs/TVC_AGENT.md` | 产品范围、状态规则、安全边界、已知断点 |

已决策事项不要当作缺口重新实现。

---

## 许可

本项目基于 MIT 许可的 [CutAgent](https://github.com/rishidandu/cutagent)，
移植了其 ffmpeg 滤镜图与命令序列（已摘录进决策文档 0001），保留 `LICENSE`。
运行时不依赖上游代码。
