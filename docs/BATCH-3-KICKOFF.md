# 第三批启动包 · 成本可见与提交前确认

> **用途**：在新对话中启动第三批开发的唯一入口。
> 把本文件路径发给新的开发 Agent，要求它先完整读取本文件与其中列出的必读项，再检查代码。
> 不要重新讨论已经固定的产品定位、技术栈与视频底座选型。

---

## 给新 Agent 的第一条指令

```
请完整读取 docs/BATCH-3-KICKOFF.md 及其中列出的必读文件，然后检查真实代码状态。先输出：
1. 已读取的基线与已完成范围；
2. 第三批各项的当前代码位置与现状；
3. 你计划的实施顺序与理由；
4. 每项的验证方法。
随后直接实现，不重新发散范围。
```

---

## 必读（按顺序）

| 文件 | 为什么必读 |
|---|---|
| 本文件 | 范围、约束、验收 |
| `docs/BATCH-2-KICKOFF.md` | 第一、二批已完成范围，不要重做 |
| `docs/decisions/0001-video-backend.md` | 视频底座为何是 ORZ；ffmpeg 命令序列存档（第四批用） |
| `src/utility/job-service.ts` | 第三批主战场，`submit` 需拆成两步 |
| `src/shared/orz-models.ts` | 模型清单与 `MODEL_DEFINITIONS`，价格表要与它对齐 |
| `src/shared/video-task-states.ts` | 11 态单一事实源，`PRE_SUBMIT_VIDEO_TASK_STATES` 已备好 |
| `src/utility/migrations.ts` | 加表加列的唯一正确方式，下一个编号是 `0003` |
| `tests/video-assets.test.ts` | 测试风格范本（真实 HTTP、真实文件、零 mock） |

Notion 规范：《现成能力调用规范 v2（ORZ 底座）》§3.4 计费与成本估算、§3.5 输入契约
`https://app.notion.com/p/3ccd29abbde880909800e64037cb85fb`

---

## 已固定的决策（不要重新讨论）

1. **视频底座 = ORZ 自建适配器**，不接 fal.ai，不移植 CutAgent。
2. **零 mock 数据**：拿不到真实值就返回 `null` 或抛出明确错误。
   测试不 mock fs、不 mock 网络 —— 用 `Bun.serve` 起真实 HTTP，用 `mkdtemp` 用真实目录。
3. **一阶段一提交**：`tsc` 双配置通过 + `bun test` 全绿 + `git commit`，出错则 `git reset --hard` 回上个良好点。
4. **导出 / ffmpeg / ProjectCommand 事务 / 画布交互属第四批**，本轮不做。

---

## 第一、二批已完成（不要重做）

commit `a4ca27e` → `1a0f010`，已推 `origin/main`。**135 项测试全绿，两侧 `tsc --noEmit` 无错误。**

- 第一批：migrations、视频落盘（`downloading` → `validating` → `completed`）、`deleteNodes` 清理磁盘、`currency` 改 `CNY`
- 第二批：11 态状态机、启动恢复（`job-recovery.ts`）、轮询下沉（`job-poller.ts`，3s→15s 退避）、重试链（`parent_job_id` / `root_job_id` / `attempt` + `video.chain`）
- 额外：画布合并保存（`canvas-merge.ts`）

---

## 本批要解决的核心问题

**当前用户点一次「确认并提交」，可能直接花掉 ¥43.2，而界面上没有任何金额。**

证据链：

- `agent-panel.tsx:548` 硬编码 `modelId: "bytedance/seedance-2"`、`resolution: "1080p"`
- `duration` 取项目时长，最大 15 秒
- Seedance 1080p 带参考图 ¥2.88/s × 15s = **¥43.2**
- `utility/index.ts:135` 的 `video.estimate` 返回 `amount: null`
- `job-service.ts:126` 的 `submit` 插入行后**立刻**调 ORZ，中间没有任何用户确认点

第二批把 `draft` 与 `awaiting-approval` 两态定义好了（`video-task-states.ts:54` 的 `PRE_SUBMIT_VIDEO_TASK_STATES`），但**至今无人写入这两态** —— 提交前确认这个环节在代码里根本不存在。

本批把它补上，并让金额真实可见。

---

## 第三批范围（四项）

### C1 · 价格表 ✅ 已完成

新建 `src/shared/orz-pricing.ts`，与 `orz-models.ts` 并列。测试 `tests/orz-pricing.test.ts`，11 项。

数据源为 Notion §3.4（口径 1 积分 ≈ ¥0.072，fetchedAt 2026-08-30）：

| 模型 | 480p | 720p | 1080p | 带参考图折扣价 |
|---|---|---|---|---|
| `bytedance/seedance-2` | ¥1.008/s | ¥2.16/s | ¥4.896/s | ¥0.576 / ¥1.296 / ¥2.88 |
| `kuaishou/kling-2-5-turbo` | 无此档 | ¥2.09/s | ¥3.46/s | 规范未给 |
| `google/veo-3-1` | 无此档 | ¥20.736/s | ¥20.736/s | 规范未给 |

**`minimax/hailuo-2-3` 已从整个代码库移除**（决策见下）。

硬规则：

- 导出 `PRICING_FETCHED_AT = "2026-08-30"` 与 `PRICING_DISCLAIMER`，任何展示金额的地方必须同时展示。
- **模型无该分辨率档位时返回 `null` 并给出原因**，绝不用邻近档位近似。
  Kling / Veo 的 480p 就是这种情况 —— 注意 `MODEL_DEFINITIONS` 里 Veo 的 `resolutions` **包含** `480p`（它接受该入参），但价格档不存在，两者不矛盾，已分别建模，`pricedResolutions()` 只返回可计价的档。
- **只有 Seedance 有规范给出的参考图折扣价。** Kling / Veo 规范未给折扣数字 → 用原价并置 `referenceDiscountUnknown: true`，确认面板据此提示「实际可能更低」。**不要按 40% 自行推算** —— 40% 是 Seedance 实测得出的，不是通用系数。
- 未注册模型返回 `null` 而非抛错 —— 估价环节不该因一个未知 ID 崩掉整个确认流程。
- 查表函数签名：

```ts
interface PriceLookup {
  amountPerSecond: number | null;
  discounted: boolean;
  reason: string | null;              // amountPerSecond 为 null 时必填
  referenceDiscountUnknown: boolean;  // 带参考图但该模型折扣未收录
}

export const lookupVideoPrice = (
  modelId: string,
  resolution: "480p" | "720p" | "1080p",
  hasReferenceInput: boolean
): PriceLookup => { ... }
```

### C1a · 移除 Hailuo 2.3 ✅ 已完成

**决策：不发布 `minimax/hailuo-2-3`。** 其报价 ¥36/s 且任意分辨率同价，5 秒即 ¥180 —— 比 Seedance 1080p 贵约 7 倍。本产品定位低成本试验，不需要它，也就不必把这个可疑数量级带进价格表。

已从以下位置摘除：`orz-models.ts` 的 `ORZ_MODELS` 与 `MODEL_DEFINITIONS`、`orz-adapters.ts` 的 `HailuoAdapter` 与 registry、`tests/orz-adapters.test.ts` 三处引用。新增回归测试 `no longer ships Hailuo 2.3 in any layer` 守住它不被重新引入。


### C2 · estimate 落地真实金额 ✅ 已完成

新建 `src/shared/video-estimate.ts`（纯函数，不发网络请求），接入 `utility/index.ts` 的 `video.estimate` 分支。测试 `tests/video-estimate.test.ts`，13 项。

模块分两层：`normalizeVideoParams` 把请求对齐到模型能力并记录每处调整，`estimateVideoCost` 用单价 × **实际计费秒数** 算钱、取整到分。`VideoEstimate` 类型由 `contracts.ts` 的 Schema 单向推导，估价模块不自建重复接口。

`adjustments` 已覆盖：Veo 8 秒计费（`billedSeconds` 8 / `requestedSeconds` 5 / ¥165.89）、离散档位取不短于脚本时长的最小档（Kling 7 秒 → 10 秒档）、无档够长时退回最长档并提示「请拆分该镜头」、Seedance 4–15 秒边界收敛、分辨率**只降不升**、画幅降级、Kling/Veo 带参考图追加「折扣价未收录」。

实施中另外发现并修掉两个问题：

1. **金额浮点尾数。** `2.88 × 15` 在 IEEE 754 下是 `43.199999999999996`，`2.16 × 15` 是 `32.400000000000006`。已统一取整到分。
2. **报价与提交参数不一致。** `video.submit` 此前用未规范化的原始请求，而 `estimate` 会规范化 —— Veo 的 5 秒请求被报成 8 秒的价，提交时却被 Adapter 的 `assertModel` 以「不支持 5 秒时长」拒掉。现已共用 `normalizeVideoParams`，测试 `submits exactly the parameters it quoted` 守住。

`tests/stack-compliance.test.ts` 中两条守「价格表未接入时不许编数字」的旧断言前提已消失，改为守新不变量：金额全链路可空、返回 null 必须给原因、金额与抓取日期必须同现、计费秒数与脚本秒数不得混谈。

已落地的 Schema 形状：

```ts
export const VideoEstimateSchema = Schema.Struct({
  modelId: Schema.String,
  currency: Schema.Literal("CNY"),
  amount: Schema.NullOr(Schema.Number),
  amountPerSecond: Schema.NullOr(Schema.Number),
  billedSeconds: Schema.Number,
  requestedSeconds: Schema.Number,
  discounted: Schema.Boolean,
  adjustments: Schema.Array(Schema.String),
  pricingFetchedAt: Schema.String,
  note: Schema.String
});
```

### C3 · 提交前确认面板 ✅ 已完成

已实现（commit `69c3626`），测试 `tests/submit-confirmation.test.ts`，6 项。

```
video.prepare(request)   → 建 awaiting-approval 行 → 校验与估价 → 返回 { job, estimate }，零网络请求
video.approve(jobId)     → 只接受 awaiting-approval 态 → 调 ORZ → 进 uploading
video.discard(jobId)     → 置 canceled，零网络请求
```

落地要点：

- `prepare` 不要求 API Key —— 用户应能在配置 Key 之前就看到这一镜要花多少钱。
- `approve` 只带 `jobId`，提交时用 `prepare` 落库的那份请求，用户批准后参数不可再改。
- 状态检查同时挡住重复点击确认的重复计费，以及对已在跑的任务再次提交。
- **重试走同一条确认路径**。`retry` 建 `awaiting-approval` 行返回估价，实际提交仍由 `approve` 完成。`maxAttempt` 计入待确认行，连开两个待确认重试不撞号（有测试）。
- `awaiting-approval` 已被 `PRE_SUBMIT_VIDEO_TASK_STATES` 豁免，启动恢复不会把它当悬空任务（有测试）。
- UI：原「确认并生成视频」按钮改为「查看报价」→ 确认卡片 →「确认支付并生成」/「放弃，不产生费用」。卡片展示模型、分辨率、计费秒数、单价、总额、`pricingFetchedAt`、全部 `adjustments` 与免责说明。金额无法估算时禁用「确认支付」。
- **硬编码已修**：`modelId` 取 `provider.status` 的 CTA 路由（原先写死 `bytedance/seedance-2`），`resolution` 默认 `720p`（原先写死 `1080p`，那是 720p 的 2.2 倍价），选项取自 `pricedResolutions()`。改动 Prompt 会作废旧报价。

原始规格（保留备查）：

把 `video.submit` 一步付费拆成两步 IPC：

```
video.prepare(request)   → 建 draft 行 → 校验与估价 → 置 awaiting-approval → 返回 { job, estimate }
video.approve(jobId)     → 从 draft 行读回原始 request → 调 ORZ → 进 uploading
video.discard(jobId)     → 用户放弃 → 置 canceled，不产生任何网络请求
```

要求：

- `prepare` **不发任何计费请求**。参考图上传（`POST /files`）也留到 `approve` 之后 —— 上传本身可能计费，且用户放弃时不该产生任何服务端痕迹。
- `approve` **只接受 `awaiting-approval` 态**的 job。其他态一律抛错，防止重复提交同一次确认。
- `job-service.ts` 现有 `submit(request, apiKey, lineage?)` 保留为内部方法，供 `approve` 复用。
- **重试也走确认面板**（已决策）。重试同样真实计费，且用户往往在连续失败后反复点击。
  因此 `video.retry` 的语义改为：**建一个 `awaiting-approval` 态的新 attempt 并返回估价，不直接提交**。
  实际提交仍由 `video.approve` 完成，与首次提交走同一条路径。
  链身份（`parent_job_id` / `root_job_id` / `attempt`）在 `retry` 建行时就写好，`approve` 不改动它们。
  注意 `maxAttempt` 的取值时机：`awaiting-approval` 的行也要计入，否则用户连开两个待确认重试会撞号。
- 数据库需要记住确认时的估价快照（价格会变，事后重算会失真）。migration `0003`：

```sql
ALTER TABLE video_jobs ADD COLUMN estimate_json TEXT;
ALTER TABLE video_jobs ADD COLUMN billed_seconds INTEGER;
ALTER TABLE video_jobs ADD COLUMN pricing_fetched_at TEXT;
```

- UI 侧：`agent-panel.tsx` 的 `submitFullVideo` 拆成「先看估价」→「确认」两步。确认卡片必须展示模型、分辨率、计费秒数、单价、总额、`pricingFetchedAt`、全部 `adjustments`，以及「以 ORZ 控制台实时计费为准」。
- **顺手修掉硬编码**：`modelId` 走 `resolveVideoModelForRole`，`resolution` 由用户在确认卡片上可选，默认降到 `720p`（1080p 单价是 720p 的 2.2 倍，默认给最贵档不合理）。分辨率选项取自 `pricedResolutions(modelId)`，不展示估不出价的档。


### C4 · 链路成本归集 ✅ 已完成

`chain()` 的 `totalCost` 已改为按快照真实求和。`VideoJobChainSchema` 新增 `attemptsMissingCost`。migration `0003` 给 `video_jobs` 加 `estimate_json` / `billed_seconds` / `pricing_fetched_at` 三列（全部可空），`JobService.insert` 在提交时算一次估价并落库。

已落地的汇总规则：

- 逐条尝试用**该次提交时记录的 `estimate_json` 快照**求和，不用当前价格表重算。
- 只计入 `completed` 的尝试。失败、取消、崩在提交前的不产生费用。
- **计费秒数优先取快照的 `billed_seconds`，而不是 `request.duration`。** 原实现用后者，Veo 固定 8 秒而脚本要 5 秒时会少算 3 秒、少算 ¥62.21。
- 部分尝试缺快照 → 给出已知部分的和，缺失数量记入 `attemptsMissingCost` 并在 `costNote` 说明。**只有全部产出尝试都缺快照才返回 `null`** —— 一条缺失就置 null 会让升级前有过重试的用户永远看不到金额。
- 快照 JSON 解析失败按「缺快照」处理，不让一条格式异常的旧记录把整条链的汇总带崩。

实施中发现并修掉一个 C2 遗留的缺口：**参数规范化原先只加在 `video.submit` 这个 IPC 分支上，而 `retry` 直接复用 `JobService.submit`** —— 从重试进来的请求绕过了规范化，Veo 的 5 秒重试仍会被 adapter 的 `assertModel` 拒掉。现已下移到 `JobService.submit`（所有提交路径的唯一入口）。估价快照仍按**原始请求**计算，以保证 `requestedSeconds` 是脚本真正要求的秒数而非取整结果。

这个缺口是写「按实际生成秒数计费」那条测试时暴露的：直接给 `JobService.submit` 传 Veo 5 秒请求，任务根本没提交成功，汇总拿到 0 秒。

---

## 建议实施顺序

```
C1 价格表 ✅  →  C2 estimate ✅  →  C4 链路成本 ✅  →  C3 确认面板 ✅
```

理由：

- C1 是纯数据与纯函数，无依赖，可先用单元测试把「档位缺失返回 null」「折扣只对 Seedance 生效」钉死
- C2 只改一个 switch 分支加一个 Schema，改动面小，但要把 `adjustments` 的全部分支测到
- C4 依赖 C1 的查表，但不依赖 C3 的两步流程 —— 先跑通历史行降级路径
- C3 跨 utility / preload / main / renderer 四处，且要改数据库与 UI，改动面最大，放最后

**第三批四项全部完成**：C1（`3d9a1bc`）、C2（`5806e24`）、C4（`7185412`）、C3（`69c3626`）、移除 Veo（`0476b3f`）。171 项测试全绿，两侧 `tsc` 无错误。

自 `69c3626` 起，**花钱变成两步决策**：点「查看报价」只算钱不花钱，看到金额后才决定要不要「确认支付并生成」。

遗留的一处技术债：`JobService.retry` 保留了带 `apiKey` 的 `@deprecated` 重载，仅供第二批测试兼容，Renderer/IPC 不得使用。下一步做第四批时可连同相关测试一并删除。

---

## 验收

- 价格表任何一处金额展示都带 `pricingFetchedAt` 与「以 ORZ 控制台实时计费为准」。
- Kling 480p、Veo 480p 的 `amount` 为 `null` 且 `reason` 非空；**测试必须断言它不等于任何数字**。
- Seedance 带参考图走折扣价，不带参考图走原价，两者都有测试。
- 其他两个模型（Kling / Veo）带参考图**不打折**，`referenceDiscountUnknown` 为 `true` 并在界面注明折扣未收录。
- Veo 3.1 + 脚本 5 秒 → `adjustments` 含「计费按 8 秒计」，`billedSeconds` 为 8，`requestedSeconds` 为 5。
- `video.prepare` 执行后，用 `Bun.serve` 起的假 ORZ 服务**收到零个请求**。
- `video.approve` 对非 `awaiting-approval` 态的 job 抛错。
- `video.discard` 后 job 为 `canceled`，且同样零请求。
- 重启应用后，`awaiting-approval` 的 job **不被启动恢复当成悬空任务**（`PRE_SUBMIT_VIDEO_TASK_STATES` 已备好此豁免，需有测试守住）。
- `chain().totalCost` 在全部尝试都有快照时给出真实和；部分缺失时给出已知部分并说明。
- `agent-panel.tsx` 不再出现硬编码的 `modelId` 与 `resolution` 字面量。
- 两侧 `tsc --noEmit` 无错误，`bun test tests` 全绿。

---

## 环境

- Electron 真实代码仅在 `src/main` / `preload` / `renderer` / `shared` / `utility`。
- 远程仓库 `https://github.com/fayezang/ai-tvc-agent.git`。
  **推送需要凭据，但钥匙串里当前没有** —— `security find-internet-password -s github.com`
  查无此项，`git push` 会报 `could not read Username`。需要装 `gh` 登录或配 PAT。
- `AgentUiEventSchema` 每新增成员，`src/preload/index.ts` 的 `AGENT_EVENT_TYPES` 白名单必须同步，否则事件被静默丢弃。
