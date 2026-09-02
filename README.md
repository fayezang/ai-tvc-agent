# AI TVC Agent

AI TVC Agent 是一个本地优先的 TVC 创作工作台，把高度依赖创意经验的广告制作转成可复用、可持续迭代的工作流。

它减少在 LLM、生图、生视频和文档之间反复切换造成的 Prompt 丢失、项目丢失和步骤遗漏。项目、脚本和生成素材保存在用户选择的本地目录，便于满足剧集与客户素材的安全要求。

## 工作流

```text
商业 Brief
→ AI 复述并由用户确认
→ 三条创意方向
→ Hook / Reveal / Proof / CTA 结构化脚本
├─→ 逐镜静态效果图 → 调整 Prompt → 新脚本版本
└─→ 选择最终脚本 → 整段视频 Prompt → 报价确认 → 完整视频 → 本地导出
```

当前最核心的创意能力是脚本约束。系统覆盖从 Brief、核心创意、脚本、Prompt、静态图到视频素材的决策链；静态图用于检查和迭代脚本 Prompt，不是最终视频的必需输入。

## 当前状态

完整流程已经跑通：

- 创建或打开本地项目，保存画幅、时长、Brief、脚本与素材。
- AI 复述 Brief，生成三条创意方向和五列结构化脚本。
- 校验镜头编号、总时长、图片 Prompt、Audio & SFX 与 VO。
- 按镜头生成静态效果图，保留图片版本，并将选定 Prompt 累积到新脚本版本。
- 从用户明确选择的完整脚本生成整段视频 Prompt。
- 生成前展示真实报价，用户确认后才提交付费任务。
- 后台轮询、恢复和重试任务；完成后下载、校验并保存视频。
- 将已落盘的完整 MP4 导出到用户选择的位置。

下一阶段集中细化 UI。具体方向见 [ROADMAP.md](ROADMAP.md)。

## 技术与安全边界

- Electron + React + TypeScript 桌面应用。
- React Flow 负责无限画布，Tiptap 负责 Brief、文档节点与 Prompt 输入。
- 文件系统是项目事实源；SQLite 保存可重建索引、任务与会话记录。
- 文本、图片和视频模型经 ORZ 网关调用。
- ORZ API Key 经 Electron `safeStorage` 加密后存入系统安全存储，不写入项目文件，Renderer 无法回读。
- 视频任务只有在文件下载、MP4 校验和原子落盘完成后才进入 `completed`。

## 开始使用

要求：Bun 1.4.0 或更高版本、Node.js 22 或更高版本。

```bash
git clone https://github.com/fayezang/ai-tvc-agent.git
cd ai-tvc-agent
bun install
bun test tests
bun run typecheck
bun run dev
```

`bun run dev` 会打开 Electron 窗口，不会启动浏览器页面。

首次使用时，在应用内“模型与 API”界面录入 ORZ API Key。密钥不会随 Git 或项目目录迁移，新设备需要重新录入。

## 项目数据

每个项目都是一个自包含的本地文件夹：

```text
我的项目/
├── project.json
├── canvas.json
├── nodes/*.md
├── assets/
│   ├── videos/
│   ├── storyboards/
│   └── references/
├── outputs/
└── .agent/
    ├── index.sqlite
    └── trash/
```

迁移项目时复制整个文件夹，包括隐藏的 `.agent/` 目录；随后在应用中选择“打开已有项目”。API Key 不应随项目迁移。

## 常用命令

```bash
bun run dev        # 开发模式
bun run typecheck  # Node 与 Renderer 类型检查
bun test tests     # 全量测试
bun run build      # 类型检查后构建
bun run dist       # 构建 macOS 安装包
```

当前验证基线：193 项测试通过，两个 TypeScript 配置无错误。

## 目录

```text
src/
├── main/       Electron 主进程、窗口、IPC、系统密钥
├── preload/    contextBridge 与 IPC 事件白名单
├── renderer/   React UI、画布与 Agent 面板
├── shared/     Schema、状态机与共享契约
└── utility/    项目、Agent、SQLite 与生成任务
```

数据库变更必须在 `src/utility/migrations.ts` 追加 migration，不修改已经发布的 migration。

## 文档

| 文件 | 内容 |
|---|---|
| [ROADMAP.md](ROADMAP.md) | 已完成能力与后续方向 |
| [docs/KICKOFF-HISTORY.md](docs/KICKOFF-HISTORY.md) | 四阶段实施记录 |
| [docs/TVC_AGENT.md](docs/TVC_AGENT.md) | 当前产品边界与已知缺口 |
| [docs/decisions/0001-video-backend.md](docs/decisions/0001-video-backend.md) | ORZ 生成链路决策 |
| [docs/decisions/0002-project-entry-points.md](docs/decisions/0002-project-entry-points.md) | 项目入口决策 |

## 已知环境问题

部分 macOS 环境会以 `library load disallowed by system policy` 拦截 Rollup、esbuild 或 Lightning CSS 的原生模块。这会影响 `dev` 和 `build`，但不影响测试与类型检查。跨平台打包验证列在 Roadmap 中。

## License

MIT。见 [LICENSE](LICENSE)。仓库保留必要的第三方授权信息；这不代表当前应用存在对应的运行时依赖。
