# 0001 · 视频生成底座采用 ORZ 自建适配器

- 状态：已采纳
- 日期：2026-08-30
- 决策者：fayezang

## 背景

Notion 启动包与《现成能力调用规范》§3.2 要求移植上游开源项目 [CutAgent](https://github.com/rishidandu/cutagent) 的四个模块作为视频生成底座：`model-adapters`、`style-engine`、`job-recovery`、`video-export`。

实际实现走的是自建 ORZ 网关适配器（`src/utility/providers/orz-adapters.ts`）。基线与实现出现分叉，本文档记录最终裁定。

## 实测结论

对 CutAgent 四个模块逐一评估可移植性：

| 模块 | 结论 | 原因 |
|---|---|---|
| `model-adapters.ts` | 不移植 | 输出的 `endpointId` 是 fal.ai 端点语义，与 ORZ 的 `POST /videos/generations` + 任务轮询模型不兼容。仅 prompt 增强逻辑有参考价值。 |
| `style-engine.ts` | 不移植 | 依赖 `frame-extractor.ts`，后者用 `document.createElement("video")` 抽帧，是纯 DOM 实现，Utility Process（Node 环境）无法运行。 |
| `job-recovery.ts` | 不移植 | 全部基于 `localStorage`，其语义已被 `video_jobs` 表完整覆盖。 |
| `video-export.ts` | **部分移植** | 依赖 CDN 加载 wasm、Blob 与 Next.js `/api/` 路由，均不可用于 Electron。**唯一高价值是 ffmpeg 滤镜图与命令序列**，已摘录至本文档附录。 |

四个模块中只有约一个模块的有效内容。

## 决策

1. **视频底座 = ORZ 自建适配器**，不引入 fal.ai。
   ORZ 单一 API Key 同时覆盖文本、图片、视频三类模型，已跑通生产链路。

2. **CutAgent 仅作一次性参考来源**，不作为运行时依赖。
   因此**不需要锁定 CutAgent commit** —— 迁移阻断条件中的该项不再适用。
   本文档附录已完整保存所需知识，上游仓库后续变更不影响本项目。

3. **移除 Next.js 遗留代码**（`src/app`、`src/components`、`src/lib`、`src/types`、`supabase/` 等）。
   这些目录不在 Electron 运行路径上，但会导致代码搜索污染，并使新接手者误判本项目使用了 CutAgent。

4. **保留 `LICENSE`**。CutAgent 采用 MIT 许可，本项目移植了其 ffmpeg 命令序列，保留原始授权文件在法务上更稳妥。

5. 同步更新 Notion《现成能力调用规范》§3，消除基线分叉。

## 影响

- 第四批导出功能改用 `ffmpeg-static` 打包平台原生二进制，通过 `child_process` 在 Utility Process 调用，**禁止 CDN 加载**。
- 滤镜图与命令序列直接复用附录内容，只需把 `ffmpeg.exec([...])` 换成 `spawn(ffmpegPath, [...])`。

---

## 附录：从 `src/lib/video-export.ts` 移植的 ffmpeg 命令序列

原始位置 `src/lib/video-export.ts:141-385`（文件已于本轮删除）。

### 画幅归一滤镜

目标尺寸按项目画幅取（项目级画幅是唯一事实源，镜头级仅作旧数据回退）：

| 画幅 | 尺寸 |
|---|---|
| 16:9 | 1280×720 |
| 1:1 | 1080×1080 |
| 4:3 | 960×720 |
| 3:4 | 720×960 |
| 9:16（默认） | 720×1280 |

```
scale={tw}:{th}:force_original_aspect_ratio=decrease,
pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2,
setsar=1
```

### 视频拼接

**重要前提**：concat demuxer 配 `-c copy` 在各输入编码参数不一致时会**静默截断到第一个输入的时长**。不同视频模型产出的流参数不同，因此必须始终重新编码，不可用 `-c copy`。

单个输入：
```
-i scene0.mp4 -vf {normFilter} -r 24 -pix_fmt yuv420p -an video_only.mp4
```

多个输入，优先 concat demuxer（逐个处理，内存占用低）：
```
-f concat -safe 0 -i concat.txt -vf {normFilter} -r 24 -pix_fmt yuv420p -an video_only.mp4
```
`concat.txt` 每行格式 `file 'sceneN.mp4'`。

失败则回退 filter-complex（对异构源更稳健，但所有输入同时载入，内存占用高）：
```
-i scene0.mp4 -i scene1.mp4 ...
-filter_complex "[0:v]{normFilter},fps=24[v0];[1:v]{normFilter},fps=24[v1];[v0][v1]concat=n={N}:v=1:a=0[outv]"
-map [outv] -pix_fmt yuv420p video_only.mp4
```

### 旁白拼接

单条直接转封装；多条走 concat demuxer，失败则退化为只用第一条：
```
-f concat -safe 0 -i vo_concat.txt -c copy all_vo.mp3
```

### 音频混合

旁白 + 音乐（音乐压至 25% 音量，`apad` 补齐时长防止提前结束）：
```
-i video_only.mp4 -i all_vo.mp3 -i music.mp3
-filter_complex "[1:a]apad[vo];[2:a]volume=0.25,apad[bg];[vo][bg]amix=inputs=2:duration=first[aout]"
-map 0:v -map [aout] -c:v copy -c:a aac -shortest output.mp4
```

仅旁白：
```
-i video_only.mp4 -i all_vo.mp3 -map 0:v -map 1:a -c:v copy -c:a aac -shortest output.mp4
```

仅音乐（音量 50%）：
```
-i video_only.mp4 -i music.mp3 -filter_complex "[1:a]volume=0.5[bg]"
-map 0:v -map [bg] -c:v copy -c:a aac -shortest output.mp4
```

无附加音频（保留视频原生音轨）：
```
-i video_only.mp4 -c copy output.mp4
```

### 移植到 Node 时需要的改动

1. `ffmpeg.exec([...])` → `spawn(ffmpegStaticPath, [...])`，虚拟文件系统读写改为真实路径。
2. 新增 trim：视频拼接前用 `-ss {trimStart} -t {duration}` 预切，以对齐脚本镜头时长。
3. 新增 `keepNativeAudio` 开关：视频模型原生生成的音频需要保留时，混音步骤改为三路 amix。
4. 移除全部 CDN 加载逻辑，二进制随 `electron-builder` 的 `asarUnpack` 分发。
