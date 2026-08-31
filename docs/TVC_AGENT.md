# AI TVC Agent · 产品范围与边界

> 本文描述**当前实现**的产品范围、状态规则与安全边界。
> 与 Notion《现成能力调用规范 v2（ORZ 底座）》配套：规范定义应该做成什么样，本文记录已经做成什么样。
> 两者冲突时以 `docs/decisions/` 下的决策文档为准。

架构基线：Electron + bun + electron-vite，视频与图片经 ORZ 网关。
**不使用 fal.ai，不移植 CutAgent 运行时代码**（依据见 `docs/decisions/0001-video-backend.md`）。

---

## 主链路

```
Brief → AI 复述确认 → 三条创意方向 → 结构化脚本
                                      ├─→ 静态效果图 → Prompt 调整 → 新脚本版本（可循环）
                                      └─→ 整片视频生成 → 导出
```

最终视频由用户明确选中的一个脚本版本转译为整段 Prompt，一次提交一条精确项目时长的任务。
选中任意一个脚本时，“生成静态效果图”和“生成完整视频”始终是两个并列入口；静态图只用于
打磨脚本第三列 Prompt，不是最终视频的前置步骤、必需输入或默认参考图。

## 节点类型

`brief` / `creative-direction` / `script` / `storyboard` / `storyboard-overview` /
`storyboard-frame` / `video` / `audio` / `export`（`NodeKindSchema`）

节点状态：`draft` / `awaiting-approval` / `approved` / `generating` / `completed` / `failed`

画布只注册了 `document` 与 `storyboardImage` 两种渲染器。其余类型复用文档渲染。

## 脚本校验规则

`validateScriptShots` 强制：

- 至少一个镜头，编号不重复，格式必须为 `S1` / `S2` …
- 每镜时长 > 0，**全部镜头时长之和必须严格等于项目时长**（容差 0.001 秒）
- 每镜必须有 Prompt 与 Audio & SFX Prompt
- Prompt 与 Audio & SFX Prompt **必须是英文** —— 含中日韩字符直接拒绝

## 视频任务状态机

13 态，单一事实源在 `src/shared/video-task-states.ts`：

```
draft → awaiting-approval → uploading → queued → generating
      → downloading → validating → completed
```

旁路态：`interrupted`（应用被杀）、`recovering`（启动恢复中）、`failed`、`canceled`、`expired`。

**ORZ 报 completed 时任务并未真正结束。** 其 CDN 链接 14 天过期，
必须走完 `downloading` → `validating` → 落盘成功才可置 `completed`。
远程 URL 不作为唯一资产。

`draft` 与 `awaiting-approval` 属 `PRE_SUBMIT_VIDEO_TASK_STATES`，
启动恢复会跳过它们 —— 它们不是悬空任务，只是还没开始。

## 花钱是两步决策

```
video.prepare(request)  → 建 awaiting-approval 行 + 估价，零网络请求，不要求 API Key
video.approve(jobId)    → 只接受 awaiting-approval 态 → 调 ORZ
video.discard(jobId)    → 置 canceled，零网络请求
```

界面上「查看报价」只算钱不花钱；看到金额后才能「确认支付并生成」。
重试走同一条路径 —— 重试同样真实计费，且用户最容易在连续失败后反复点。

金额展示处必须同时给出 `pricingFetchedAt` 与「以 ORZ 控制台实时计费为准」。
**拿不到真实单价时返回 `null` 并说明原因，绝不用邻近档位近似。**

## 视频模型

只有两个：`bytedance/seedance-2`（默认）与 `kuaishou/kling-2-5-turbo`。

Notion 规范 §3.3 列了四个，但 `google/veo-3-1`（commit `0476b3f`）与
`minimax/hailuo-2-3`（commit `3d9a1bc`）已按「选便宜的」决策移除。
**规范里 Veo 固定 8 秒、Hailuo ¥36/s 两条已不适用，不要当缺口重新实现。**

## 安全边界

- ORZ API Key 经 `safeStorage` 加密后存入系统钥匙串，**不写任何文件**，Renderer 读不到。
- 网络请求、Key、视频下载全部位于 Utility Process。Renderer 只能调具名 IPC。
- 所有 IPC 输入输出经 Effect Schema 校验。
- 连接测试区分文本与图片链路 —— 只验文本不能证明图片可用。
- `AgentUiEventSchema` 每新增成员，`src/preload/index.ts` 的 `AGENT_EVENT_TYPES`
  白名单必须同步，否则事件被静默丢弃。

## 零 mock 约定

产品代码不得出现假数据、占位值、伪造的成功状态。拿不到真实值就返回 `null`
或抛出明确错误。

测试不 mock fs、不 mock 网络 —— 用 `Bun.serve` 起真实 HTTP 服务，
用 `mkdtemp` 用真实目录，MP4 头字节取自标准容器。

## 已知断点

| 断点 | 位置 |
|---|---|
| 音频链路为空 | `audio` 节点可创建，但 `ORZ_MODELS` 无任何 TTS / 音乐模型，建完不会发生任何事 |
| 上游改动不失效下游 | 规范 §2.7 的 `stale` 标记零实现 |
| 无撤销 | 规范 §2.7 的 ProjectCommand 事务零实现（`agent_transactions` 表是 Agent 消息记录，不是命令事务） |

参考图上传**已按 sha256 缓存**（`uploadLocalImage`，缓存落在
`assets/references/uploads.json`），符合规范 §3.2。缓存键是文件内容而非路径，
同图改名不重传、同名换图会重传，由 `tests/reference-upload-cache.test.ts` 守住。

完整视频完成后继续走 `downloading → validating → completed` 并保存到
`assets/videos/`。点击“导出已完成视频”会先打开系统“存储”对话框，再把用户选定的
已落盘 MP4 原子复制到所选路径；取消对话框不会写文件。不做 ffmpeg 拼接、裁剪或转码，
失败也不会改动源资产。

画布侧欠账：新建入口只有右键与 `Cmd+K`（规范要五个）、无语义缩放 LOD、
Agent 面板固定右侧 Dock 无三态换位、关系线无语义（只有 id/source/target）。

## 明确不做

独立 Style Board、Character Lab、专业多轨时间线、LoRA 训练、
自动角色一致性检测、广告法规审核、复杂转场、调色工程、口型同步、
Premiere / 剪映工程文件导出。

## 验证

```bash
bun test tests        # 全量测试
bun run typecheck     # tsc 双配置，应无输出
```

媒体模型需要真实账户额度，自动化测试不会代替用户发起付费生成。
