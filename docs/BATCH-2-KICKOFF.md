# 第二批启动包 · 任务可靠性

> **用途**：在新对话中启动第二批开发的唯一入口。
> 把本文件路径发给新的开发 Agent，要求它先完整读取本文件与其中列出的必读项，再检查代码。
> 不要重新讨论已经固定的产品定位、技术栈与视频底座选型。

---

## 给新 Agent 的第一条指令

```
请完整读取 docs/BATCH-2-KICKOFF.md 及其中列出的必读文件，然后检查真实代码状态。先输出：
1. 已读取的基线与已完成范围；
2. 第二批各项的当前代码位置与现状；
3. 你计划的实施顺序与理由；
4. 每项的验证方法。
随后直接实现，不重新发散范围。
```

---

## 必读（按顺序）

| 文件 | 为什么必读 |
|---|---|
| 本文件 | 范围、约束、验收 |
| `docs/decisions/0001-video-backend.md` | 视频底座为何是 ORZ 而非 CutAgent；ffmpeg 命令序列存档 |
| `docs/decisions/0002-project-entry-points.md` | 为何只有两个入口，不要把它当缺口重新实现 |
| `src/utility/job-service.ts` | 第二批主战场 |
| `src/shared/contracts.ts` | `VideoTaskStateSchema`、`VideoJobSchema`、`AgentUiEventSchema` |
| `src/utility/migrations.ts` | 加表加列的唯一正确方式 |
| `tests/video-assets.test.ts` | 本项目的测试风格范本（真实 HTTP、真实文件、零 mock） |

Notion 规范（可选，代码与文档冲突时以决策文档为准）：
《现成能力调用规范 v2（ORZ 底座）》`https://app.notion.com/p/3ccd29abbde880909800e64037cb85fb`

---

## 已固定的决策（不要重新讨论）

1. **视频底座 = ORZ 自建适配器**，不接 fal.ai，不移植 CutAgent。
2. **首次进入固定两个入口**，「导入已有脚本」已正式取消。
3. **零 mock 数据**：产品代码不得出现假数据、占位值、伪造的成功状态。
   拿不到真实值就返回 `null` 或抛出明确错误。
   测试不 mock fs、不 mock 网络 —— 用 `Bun.serve` 起真实 HTTP 服务，用 `mkdtemp` 用真实目录。
4. **一阶段一提交**：`tsc` 双配置通过 + `bun test` 全绿 + `git commit`，出错则 `git reset --hard` 回上个良好点。
5. **ProjectCommand 事务、导出、画布交互、Agent 消息类型属第四批**，本轮不做。

---

## 第一批已完成（不要重做）

commit `a4ca27e` → `7b47611`，5 个提交，已推送 `origin/main`。

- 全部源码纳入版本控制（此前一行都没有）
- 清除 Next.js 遗留与多余锁文件，只剩 `bun.lock`
- `src/utility/migrations.ts`：有序 migration + `schema_migrations` 表，可从零建库、可升级旧库
- `.env.example`
- **视频落盘**：`src/utility/video-assets.ts`，`completed` 前必经 `downloading` → `validating`
- **修复 `writeAtomic` 二进制损坏**（对 `Uint8Array` 传了 `"utf8"`）
- `selectedOutputUrl` / `localPaths` / `selectedLocalPath` 打通
- `ProjectService.deleteNodes`：删节点同步清理磁盘，文件移入 `.agent/trash/{时间戳}/`
- `currency` 由 `USD` 改为 `CNY`

**70 项测试全绿，两侧 `tsc --noEmit` 无错误。**

---

## 第二批范围（四项）

### B1 · 补齐任务状态机

`VideoTaskStateSchema`（`contracts.ts:166`）声明 11 态，实际只用 7 态。

本轮新增两态：

| 状态 | 语义 |
|---|---|
| `interrupted` | 应用退出时任务仍在执行，重启后发现它悬着 |
| `recovering` | 已发现悬空任务，正在向 ORZ 查询真实状态 |

`draft` 与 `awaiting-approval` **留给第三批**的提交前确认面板，本轮不动。

### B2 · 重试链

现状（`job-service.ts:119`）：`retry` 直接调 `submit`，**新建 jobId 且旧行残留**，两者无任何关联。
用户看到两条孤立记录，无法知道哪次是哪次的重试，成本也无法归集。

改为：

```ts
interface RetryChain {
  parentJobId: string | null;  // 上一次尝试
  rootJobId: string;           // 首次尝试，用于归集整条链的成本
  attempt: number;             // 从 1 开始
}
```

要求：
- 原 job 行保留，不删不改其历史结果
- 新 job 记录 `parent_job_id` 与 `root_job_id`
- 能查出一条链的全部尝试与累计成本

### B3 · 轮询下沉到 Utility Process

现状（`agent-panel.tsx:249`）：renderer 用 `setInterval` 每 3 秒轮询，**固定间隔不退避**。

三个问题：
1. 窗口关闭或组件卸载即停止 —— 任务在服务端继续跑，但本地不再跟踪
2. 每 tick 走三跳 IPC（renderer → main → utility → main → renderer）
3. 长任务下高频请求，无退避

改为 Utility Process 内的 `JobPoller`：
- 起始 3 秒，逐步退避到 15 秒上限
- 复用已有事件通道：`parentPort.postMessage({ type: "event", event })`（`utility/index.ts:105`）
  → main 转发（`ipc.ts:66`）→ renderer 监听
- `AgentUiEventSchema` 新增 `{ type: "video-job", job }`
- **preload 的事件白名单需同步添加**，否则事件会被静默丢弃

### B4 · 启动恢复

启动包要求「应用退出前保存 requestId；重启后查询并恢复」，当前完全没有。

在 `project.open`（`utility/index.ts:47`）挂载：

```
扫描非终态的 video_jobs
  → 置 interrupted
  → 有 provider_task_id 的置 recovering，交给 JobPoller
  → 无 provider_task_id 的置 failed + retryable（提交时就崩了，服务端没有这个任务）
```

**注意**：若恢复后发现任务已在服务端完成，必须走第一批的落盘流程
（`persistVideoOutputs`），不能直接置 `completed` —— 否则又退回「只存远程 URL」的老问题。

---

## 建议实施顺序

```
B1 状态机  →  B4 启动恢复  →  B3 轮询下沉  →  B2 重试链
```

理由：
- B1 是纯类型与 migration，无依赖，先做可让后续有状态可用
- B4 依赖 B1 的新状态，但不依赖 poller —— 可先用现有 `refresh` 跑通恢复逻辑
- B3 改动面最大（跨三个进程），放在恢复逻辑稳定之后
- B2 独立性最强，放最后不阻塞其他项

---

## 关键约束

**数据库变更必须走 migration。** 新增列时在 `src/utility/migrations.ts` 追加一条，
不要修改已发布的 `0000` / `0001` —— 已升级过的数据库不会重跑它们。
追加后同步更新 `tests/migrations.test.ts` 的列清单断言（放在末尾并注明来自哪条 migration）。

**事件必须过 Schema。** `AgentUiEventSchema` 是 union，新增成员后
preload 的类型守卫与白名单都要同步，否则事件在 IPC 边界被静默丢弃。

**恢复不得重复生成。** 只查询已有 `provider_task_id`，绝不重新提交 —— 那会产生真实计费。

---

## 验收

- [ ] 状态机含 `interrupted` / `recovering`，且真实被使用而非仅声明
- [ ] 重试保留原 job 行，能查出整条链与累计成本
- [ ] 关闭窗口后重新打开，进行中的任务仍在跟踪
- [ ] 轮询间隔随时间退避，不是固定 3 秒
- [ ] 恢复时若任务已完成，视频正确落盘而非只存 URL
- [ ] 无 `provider_task_id` 的悬空任务被正确判为失败且可重试
- [ ] 恢复流程不产生任何新的生成请求
- [ ] `tsc` 双配置无错误，`bun test` 全绿（当前基线 70 项）

---

## 环境备忘

```bash
# bun 不在 PATH
~/.bun/bin/bun test tests

# 类型检查（两个都要跑）
npx tsc -p tsconfig.node.json --noEmit
npx tsc -p tsconfig.web.json --noEmit
```

- **`better-sqlite3` 在 bun/node 下加载即崩溃**（SIGKILL / Exit Code 137）——
  其原生模块由 `electron-builder install-app-deps` 针对 Electron ABI 编译。
  测试改用 `bun:sqlite`，它同为真实 SQLite 引擎。
  这正是 `runMigrations` 接受最小接口 `MigrationRunnerDatabase` 而非具体驱动的原因。
- **本机 `electron-vite build` 跑不通**：macOS 代码签名策略拦截 rollup/esbuild 原生模块
  （`library load disallowed by system policy`）。打包验证只能在新电脑做。
- Electron 真实代码仅在 `src/main` / `preload` / `renderer` / `shared` / `utility`。
- 远程仓库 `https://github.com/fayezang/ai-tvc-agent.git`，凭据已存钥匙串。
