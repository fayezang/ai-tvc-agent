# 第四批启动包 · 导出与交片

> **用途**：在新对话中启动第四批开发的唯一入口。
> 把本文件路径发给新的开发 Agent，要求它先完整读取本文件与其中列出的必读项，再检查代码。
> 不要重新讨论已经固定的产品定位、技术栈与视频底座选型。

---

## 给新 Agent 的第一条指令

```
请完整读取 docs/BATCH-4-KICKOFF.md 及其中列出的必读文件，然后检查真实代码状态。先输出：
1. 已读取的基线与已完成范围；
2. 第四批各项的当前代码位置与现状；
3. D0 音频决策你建议选哪个方案，以及理由；
4. 你计划的实施顺序与每项的验证方法。
等我确认 D0 后再开始实现，不重新发散范围。
```

**注意 D0 是产品决策，必须等用户确认再动手。** 它决定 D2 的滤镜图要不要混音分支。

---

## 必读（按顺序）

| 文件 | 为什么必读 |
|---|---|
| 本文件 | 范围、约束、验收 |
| `docs/TVC_AGENT.md` | 当前产品范围与已知断点（已对齐真实代码，可信） |
| `docs/decisions/0001-video-backend.md` | **附录含完整 ffmpeg 滤镜图与命令序列，D2 直接复用** |
| `docs/BATCH-3-KICKOFF.md` | 第三批已完成范围，不要重做 |
| `src/utility/video-assets.ts` | 视频落盘现状；导出要读它落的文件 |
| `src/utility/index.ts:178` | `video.renderProject` 抛错占位处，D2 主战场 |
| `src/shared/contracts.ts:527` | `renderProject` 已有契约签名 |
| `src/utility/migrations.ts` | 加表加列的唯一正确方式，下一个编号是 `0004` |
| `tests/reference-upload-cache.test.ts` | 测试风格范本（真实 HTTP、真实目录、零 mock、含可失败性验证） |

Notion 规范：《现成能力调用规范 v2（ORZ 底座）》§3.5 输入契约、§3.9 导出
`https://www.notion.so/3ccd29abbde880909800e64037cb85fb`

---

## 已固定的决策（不要重新讨论）

1. **视频底座 = ORZ 自建适配器**，不接 fal.ai，不移植 CutAgent 运行时代码。
2. **视频模型只有 Seedance（默认）与 Kling 两个。** Veo（`0476b3f`）与 Hailuo（`3d9a1bc`）
   已按「选便宜的」决策移除。规范 §3.3 列了四个，那份清单已过期 ——
   **不要把 Veo / Hailuo 当缺口重新实现。**
3. **零 mock 数据**：拿不到真实值就返回 `null` 或抛出明确错误。
   测试不 mock fs、不 mock 网络 —— 用 `Bun.serve` 起真实 HTTP，用 `mkdtemp` 用真实目录。
4. **一阶段一提交**：`tsc` 双配置通过 + `bun test` 全绿 + `git commit`，
   出错则 `git reset --hard` 回上个良好点。
5. **ffmpeg 禁止 CDN 加载**，用 `ffmpeg-static` + `ffprobe-static` 打包平台原生二进制，
   通过 `child_process` 在 Utility Process 调用。
6. **画布交互（§2 全部）属第五批**，本轮不做。

---

## 第一至三批已完成（不要重做）

commit `a4ca27e` → `282d933`，已全部推送 `origin/main`。
**184 项测试全绿（21 文件），两侧 `tsc --noEmit` 无错误。**

- 第一批：migrations、视频落盘（`downloading` → `validating` → `completed`）、
  `deleteNodes` 清理磁盘、`currency` 改 `CNY`
- 第二批：13 态状态机、启动恢复（`job-recovery.ts`）、
  轮询下沉（`job-poller.ts`，3s→15s 退避）、重试链（`parent_job_id` / `root_job_id` / `attempt`）
- 第三批：价格表（`orz-pricing.ts`）、真实金额估算（`video-estimate.ts`）、
  提交前两步确认（`prepare` / `approve` / `discard`）、链路成本按快照归集
- 第 3.5 批：删 deprecated retry 重载、重写 `TVC_AGENT.md`、
  补 Prompt 一致性测试（6 项）、补参考图缓存测试（7 项）

**参考图 sha256 缓存已实现**（`agent-service.ts` 的 `uploadLocalImage`，
缓存落 `assets/references/uploads.json`），符合规范 §3.2，有测试守住。不要重做。

---

## 本批要解决的核心问题

**现在这个产品能生成视频，但交不出片。**

`video.renderProject`（`utility/index.ts:178`）直接抛错：
「基础 MP4 合成将在视频生成闭环阶段启用；当前未执行任何伪导出。」

IPC 骨架其实已经通了 —— `contracts.ts:527` 有签名，`preload/index.ts:87` 有转发，
`ipc-channels.ts:40` 有频道名。**只有 utility 层的实现是空的。**

用户走完 Brief → 创意 → 脚本 → 分镜 → 视频，拿到的是一堆散落的单镜 MP4，
没有一个能交付的成片。这是从「能演示」到「能交片」之间唯一的坎。

---

## 第四批范围（四项）

### D0 · 音频链路决策（**先等用户确认，不要自己定**）

**问题**：`audio` 节点入口已经对用户开放，但底层什么都没有。

证据：
- `NodeKindSchema` 有 `"audio"`（`contracts.ts:18`）
- `node-creator.tsx:10` 给了「旁白与音乐」按钮
- `project-service.ts:40` 有中文标签
- 但 `ORZ_MODELS` 里**没有任何 TTS 或音乐模型**
- `src/utility/` 全域**零音频生成实现**

用户现在能建这个节点，建完什么都不会发生。

**连带影响**：`docs/decisions/0001` 附录里的混音命令
（`[vo][bg]amix=inputs=2:duration=first[aout]`）**无源可混**。
D2 导出到底做几路音频，取决于这里怎么定。

两个方案：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A · 补模型** | 在 `ORZ_MODELS` 加 TTS 与音乐模型，实现音频生成链路 | 工作量大，且需先确认 ORZ 是否提供、价格多少（价格表要同步扩） |
| **B · 摘掉入口** | 按 `0002-project-entry-points` 的先例移除 `audio` 节点入口，导出只做纯视频拼接 + 保留模型原生音轨 | 快，但产品少一块能力 |

**建议 B**，理由：规范 §3.9 已把「可选择保留模型原生音频」列入 MVP 范围，
Seedance 与 Kling 都能生成原生音轨，纯视频拼接 + 原生音轨已构成可交付成片。
补 TTS 是独立能力，不该阻塞导出。

选 B 时必须：摘入口、在 `TVC_AGENT.md` 记明原因、
在 `0001` 附录旁注「混音命令暂无源，待音频链路补齐后启用」。

### D1 · trim 机制

规范 §3.5 硬规则：

> 脚本镜头时长与模型可生成时长不是同一概念。模型可输出更长素材，
> 再通过 `trimStart` 和 `trimEnd` 裁到脚本时长。**系统不得静默改变脚本总时长。**

现状：`trimStart` / `trimEnd` 全代码零实现，只有 `video-estimate.ts:74` 一句注释提到
「裁剪由 trimStart / trimEnd 完成」—— 那个注释目前是空头承诺。

为什么必需：Kling 只有 5 / 10 秒离散档，脚本要 7 秒时会生成 10 秒素材。
不裁就是把 10 秒塞进 7 秒的位置，成片总时长必然超出脚本。
第三批的 `normalizeVideoParams` 已经在 `adjustments` 里记录了「取 10 秒档」这件事，
但没人把多出来的 3 秒裁掉。

要求：
- trim 值存在哪里要先定：`video_jobs` 加列（migration `0004`），
  还是存在节点 manifest 里。选前者更一致（估价快照就是这么存的）。
- **默认值不能猜**。生成 10 秒、脚本要 7 秒时，裁头还是裁尾？
  建议默认 `trimStart = 0`、`trimEnd = billedSeconds - requestedSeconds`（保留开头），
  但要允许用户调整，且**界面必须显示实际用了哪一段**。
- 纯数据层实现 + 纯函数测试，不依赖 ffmpeg。D2 消费它。

### D2 · ffmpeg 导出

规范 §3.9 的 MVP 范围：

1. 按镜头顺序拼接
2. 应用 `trimStart` 与 `trimEnd`
3. 统一画幅、分辨率、帧率、像素格式
4. 混合逐镜 VO 与背景音乐 ← **取决于 D0**
5. 可选择保留模型原生音频
6. 导出 MP4

**滤镜图与命令序列不要自己设计**，`docs/decisions/0001` 附录已完整存档，
包含画幅归一滤镜、拼接（含 concat demuxer 与 filter-complex 两条路径）、
旁白拼接、四种音频混合分支。只需把 `ffmpeg.exec([...])` 换成 `spawn(ffmpegPath, [...])`。

必须注意的坑（附录已写明，容易踩）：

- **concat demuxer 配 `-c copy` 在各输入编码参数不一致时会静默截断到第一个输入的时长。**
  不同模型产出的流参数不同，**必须始终重新编码，不可用 `-c copy`**。
  这个坑不会报错，只会让成片莫名变短。
- concat demuxer 失败要回退 filter-complex（对异构源更稳健，但内存占用高）。
- `electron-builder.yml` 的 `asarUnpack` 现在**只有 `better-sqlite3`**，
  必须追加 ffmpeg / ffprobe，且运行时路径要做 `app.asar` → `app.asar.unpacked` 替换。
- 导出失败**必须保留单镜文件与 RenderJob 日志**，不丢失任何已生成资产（规范硬要求）。

产物落 `outputs/`（`project-service.ts:100` 已建好这个空目录）。

### D3 · 尾帧连续性与并发控制

规范 §3.8：

- 使用上一镜尾帧链路时，相关镜头**必须顺序生成**
- 只用商品 / 角色 / 风格参考时，镜头可按并发上限**并行生成**
- 一个镜头失败不取消已完成的其他镜头
- 用户修改上游脚本或分镜后，旧视频保留但标记 `stale`

现状全零实现。放最后是因为它依赖 D2 的导出链路成型 ——
没有导出就没法验证「顺序生成到底有没有让画面连上」。

`stale` 标记属规范 §2.7，与第五批的事务层耦合，本轮可只做视频侧的最小标记。

---

## 建议实施顺序

```
D0 音频决策（等用户）→ D1 trim → D2 ffmpeg 导出 → D3 尾帧并发
```

理由：

- D0 是决策，不写代码，但决定 D2 的音频分支数量。**不先定就会白写混音代码。**
- D1 是纯数据层，无 ffmpeg 依赖，可先用纯函数测试把「裁多少、从哪裁」钉死
- D2 是本批主体，跨 utility / 打包配置 / UI
- D3 依赖 D2 成型才能验证效果

---

## 验收

- `video.renderProject` 返回真实的 `outputPath`，文件在 `outputs/` 下且是可播放 MP4。
- 拼接**始终重新编码**，不出现 `-c copy` 拼接多输入的路径（测试断言命令行参数）。
- 脚本 7 秒 + Kling 生成 10 秒 → 成片该镜为 7 秒，`trimEnd` 为 3。
- 成片总时长等于脚本总时长（容差 0.1 秒内），不因取整档位而变长。
- 导出失败后单镜 MP4 仍在磁盘，RenderJob 日志可查。
- `electron-builder.yml` 的 `asarUnpack` 含 ffmpeg 与 ffprobe。
- 使用尾帧链路的镜头严格顺序生成；无依赖时受控并行（测试用假 ORZ 记录调用时序）。
- 两侧 `tsc --noEmit` 无错误，`bun test tests` 全绿（当前基线 184 项）。

---

## 环境

- Electron 真实代码仅在 `src/main` / `preload` / `renderer` / `shared` / `utility`。
- 远程仓库 `https://github.com/fayezang/ai-tvc-agent.git`，
  凭据（PAT）已存 macOS 钥匙串，推送免密。
- **已知环境问题**：本机 macOS 代码签名策略会拦截 rollup / esbuild / lightningcss
  的原生模块，`bun run dev` 与 `build` 起不来，但 `bun test` 与 `typecheck` 不受影响。
  详见 README「已知环境问题」。**这是机器问题不是代码问题，不要试图改代码绕过。**
  这意味着 **D2 的导出无法在本机跑 `dev` 手工验证**，必须靠测试覆盖。
- `AgentUiEventSchema` 每新增成员，`src/preload/index.ts` 的 `AGENT_EVENT_TYPES`
  白名单必须同步，否则事件被静默丢弃。
