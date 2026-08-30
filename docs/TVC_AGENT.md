# AI TVC Agent MVP

## 产品范围

本地版实现 PRD 的一周 MVP 主链路：

1. Brief 表单、商品/角色/Logo/风格素材和必选时长。
2. “我理解的 Brief”复述、编辑、对话纠正与显式确认。
3. 恰好三条一句话创意方向；可选择、修改或融合为一个当前草案。
4. 根据 5 / 8 / 10 / 15 秒生成动态镜头数的结构化脚本。
5. 镜头级对话修改、字段差异、一次撤销、时长/VO/完整性校验。
6. 使用 FLUX 逐镜生成静态分镜；每镜最多三个版本，单独确认。
7. 把确认分镜作为首帧或视觉参考交给 CutAgent 的模型适配器。
8. 多模型视频生成与比较、VO、音乐、预览和浏览器内 MP4 导出。

明确未加入独立 Style Board、Character Lab、专业多轨时间线、LoRA 训练、自动角色一致性检测或广告法规审核。

## 本地启动

需要 Node.js 20+ 和 pnpm。

```bash
pnpm install
pnpm dev
```

打开 `http://localhost:3000`。首次进入是空白 Brief，时长没有默认值，必须主动选择。可按“演示 Brief”填入示例文案；示例也不会预选时长或伪造上传素材。项目会自动保存在浏览器 `localStorage`，fal.ai Key 只保留在当前页面会话中，不会写入持久存储。

## 生成服务

Brief 复述、创意方向和脚本生成使用可离线运行的、约束明确的本地生成器，保证没有 Key 时也能演示完整前置决策链。

真实媒体生成使用用户自己的 fal.ai Key：

- 有商品/角色参考图的分镜：`fal-ai/flux-pro/kontext/max/multi`
- 无参考图的分镜：`fal-ai/flux/schnell`
- 视频：沿用 CutAgent 的 Kling、Veo、MiniMax、Seedance、Luma、Wan、Hunyuan 模型适配器
- 配音与音乐：沿用 CutAgent 的 Kokoro / ElevenLabs、CassetteAI / Stable Audio

当前是本地 BYOK 模式，Key 由浏览器直接配置给 fal.ai 客户端。若部署到共享或公开环境，必须改成服务端代理，不能把长期 Key 暴露给浏览器。

## 状态与失效规则

- 未确认 Brief，不能进入创意。
- 未确认创意，不能生成脚本。
- 脚本校验未通过，不能进入分镜。
- 所有分镜未逐个确认，不能进入视频。
- 修改已确认 Brief 的核心字段，会清空创意、脚本、分镜和视频。
- 修改一个镜头，只会清空该镜头的分镜和视频。
- 全局创意修改先显示受影响镜头，用户回复“确认”后才应用。
- 单镜对话默认保留总时长、VO 和其他镜头，并提供一次撤销。

## 代码结构

```text
src/
├── components/tvc/            # 五阶段工作台、导航和阶段对话
├── lib/tvc-workflow.ts        # 领域规则、生成器、校验和 CutAgent 映射
├── lib/storyboard-generation.ts # FLUX 单镜静态分镜
├── types/tvc.ts               # 项目、Brief、创意、镜头与版本类型
└── lib/tvc-workflow.test.ts   # 核心状态与时长测试
```

原 CutAgent 的 `fal.ts`、`model-adapters.ts`、`audio.ts`、`video-export.ts`、`CompareModal` 和 `PreviewPlayer` 继续复用。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
```

自动化测试覆盖：Brief 门槛、三方向差异、四种目标时长的严格求和、完整脚本字段、单镜修改保护、下游失效与阶段锁定。

媒体模型需要真实账户额度，自动化测试不会代替用户发起付费生成。没有 fal.ai Key 时，应用仍可完整走到分镜生成门槛，并明确显示所需操作。
