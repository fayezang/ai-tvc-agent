import { Schema } from "effect";

export const AdDurationSchema = Schema.Literal(5, 8, 10, 15);
export type AdDuration = typeof AdDurationSchema.Type;

export const AspectRatioSchema = Schema.Literal("21:9", "16:9", "4:3", "1:1", "3:4", "9:16");
export type AspectRatio = typeof AspectRatioSchema.Type;

export const NodeKindSchema = Schema.Literal(
  "brief",
  "creative-direction",
  "script",
  "storyboard",
  "storyboard-overview",
  "storyboard-frame",
  "video",
  "audio",
  "export"
);
export type NodeKind = typeof NodeKindSchema.Type;

export const NodeStatusSchema = Schema.Literal(
  "draft",
  "awaiting-approval",
  "approved",
  "generating",
  "completed",
  "failed"
);
export type NodeStatus = typeof NodeStatusSchema.Type;

export const CanvasNodeSchema = Schema.Struct({
  id: Schema.String,
  kind: NodeKindSchema,
  title: Schema.String,
  bodyPath: Schema.String,
  position: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  shotId: Schema.optional(Schema.String),
  scriptVersion: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  sourceScriptNodeId: Schema.optional(Schema.String),
  imageSetId: Schema.optional(Schema.String),
  status: NodeStatusSchema
});
export type CanvasNode = typeof CanvasNodeSchema.Type;

export const CanvasEdgeSchema = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  target: Schema.String
});

export const CanvasSnapshotSchema = Schema.Struct({
  version: Schema.Literal(1),
  nodes: Schema.Array(CanvasNodeSchema),
  edges: Schema.Array(CanvasEdgeSchema),
  viewport: Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    zoom: Schema.Number
  })
});
export type CanvasSnapshot = typeof CanvasSnapshotSchema.Type;

export const ProjectSummarySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  rootPath: Schema.String,
  adDuration: AdDurationSchema,
  aspectRatio: Schema.optional(AspectRatioSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String
});
export type ProjectSummary = typeof ProjectSummarySchema.Type;

export const ProjectStateSchema = Schema.Struct({
  project: ProjectSummarySchema,
  canvas: CanvasSnapshotSchema
});
export type ProjectState = typeof ProjectStateSchema.Type;

export const CreateProjectRequestSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80)),
  adDuration: AdDurationSchema,
  aspectRatio: AspectRatioSchema,
  briefMarkdown: Schema.String
});
export type CreateProjectRequest = typeof CreateProjectRequestSchema.Type;

export const OpenProjectRequestSchema = Schema.Struct({
  rootPath: Schema.String.pipe(Schema.minLength(1))
});

export const SaveCanvasRequestSchema = Schema.Struct({
  projectRoot: Schema.String,
  canvas: CanvasSnapshotSchema
});

export const ReadBodyRequestSchema = Schema.Struct({
  projectRoot: Schema.String,
  bodyPath: Schema.String
});

export const WriteBodyRequestSchema = Schema.Struct({
  projectRoot: Schema.String,
  bodyPath: Schema.String,
  markdown: Schema.String
});

export const CreateNodeRequestSchema = Schema.Struct({
  projectRoot: Schema.String,
  kind: NodeKindSchema,
  position: Schema.Struct({ x: Schema.Number, y: Schema.Number })
});

export const UpdateNodeStatusRequestSchema = Schema.Struct({
  projectRoot: Schema.String,
  nodeId: Schema.String,
  status: NodeStatusSchema
});

export const DeleteNodesRequestSchema = Schema.Struct({
  projectRoot: Schema.String,
  nodeIds: Schema.Array(Schema.String)
});

export const DeleteNodesResultSchema = Schema.Struct({
  canvas: CanvasSnapshotSchema,
  /** 被移入 .agent/trash/ 的文件路径，供用户恢复与将来的撤销事务使用。 */
  movedToTrash: Schema.Array(Schema.String)
});
export type DeleteNodesResult = typeof DeleteNodesResultSchema.Type;

export const ProviderVideoRoutingSchema = Schema.Struct({
  hook: Schema.String.pipe(Schema.minLength(1)),
  reveal: Schema.String.pipe(Schema.minLength(1)),
  proof: Schema.String.pipe(Schema.minLength(1)),
  cta: Schema.String.pipe(Schema.minLength(1))
});
export type ProviderVideoRouting = typeof ProviderVideoRoutingSchema.Type;

export const ProviderConfigurationSchema = Schema.Struct({
  apiKey: Schema.String,
  textModelId: Schema.String.pipe(Schema.minLength(1)),
  imageModelId: Schema.String.pipe(Schema.minLength(1)),
  videoModelRouting: ProviderVideoRoutingSchema
});
export type ProviderConfiguration = typeof ProviderConfigurationSchema.Type;

export const ProviderStatusSchema = Schema.Struct({
  hasApiKey: Schema.Boolean,
  textModelId: Schema.NullOr(Schema.String),
  imageModelId: Schema.NullOr(Schema.String),
  videoModelRouting: Schema.NullOr(ProviderVideoRoutingSchema),
  baseUrl: Schema.String
});
export type ProviderStatus = typeof ProviderStatusSchema.Type;

export const ProviderValidationSchema = Schema.Struct({
  ok: Schema.Boolean,
  httpStatus: Schema.NullOr(Schema.Number),
  message: Schema.String
});
export type ProviderValidation = typeof ProviderValidationSchema.Type;
export const VideoTaskStateSchema = Schema.Literal(
  "draft",
  "awaiting-approval",
  "uploading",
  "queued",
  "generating",
  "downloading",
  "validating",
  "completed",
  "failed",
  "canceled",
  "expired"
);
export type VideoTaskState = typeof VideoTaskStateSchema.Type;

export const VideoGenerationRequestSchema = Schema.Struct({
  projectRoot: Schema.String,
  shotId: Schema.String,
  role: Schema.Literal("hook", "reveal", "proof", "cta", "emotional-proof", "other"),
  modelId: Schema.String,
  prompt: Schema.String.pipe(Schema.minLength(1)),
  negativePrompt: Schema.optional(Schema.String),
  duration: Schema.Number.pipe(Schema.int(), Schema.between(4, 15)),
  aspectRatio: AspectRatioSchema,
  resolution: Schema.Literal("480p", "720p", "1080p"),
  fps: Schema.optional(Schema.Literal(24, 30)),
  referenceImageUrls: Schema.Array(Schema.String),
  referenceVideoUrls: Schema.Array(Schema.String),
  referenceAudioUrls: Schema.Array(Schema.String),
  generateAudio: Schema.Boolean,
  seed: Schema.optional(Schema.Number.pipe(Schema.int()))
});
export type VideoGenerationRequest = typeof VideoGenerationRequestSchema.Type;

export const VideoJobSchema = Schema.Struct({
  id: Schema.String,
  providerTaskId: Schema.NullOr(Schema.String),
  modelId: Schema.String,
  state: VideoTaskStateSchema,
  progress: Schema.NullOr(Schema.Number),
  stage: Schema.NullOr(Schema.String),
  /** ORZ 返回的 CDN 链接。有时效（官方标注 14 天），不可作为唯一资产。 */
  outputUrls: Schema.Array(Schema.String),
  /** 已落盘到项目目录的相对路径，与 outputUrls 顺序对应。这是持久的事实源。 */
  localPaths: Schema.Array(Schema.String),
  /** 用户选定的版本。此前只写入数据库却从未读出，导致选择在刷新后丢失。 */
  selectedOutputUrl: Schema.NullOr(Schema.String),
  /** 选中版本对应的本地路径。UI 应优先使用它而非远程 URL。 */
  selectedLocalPath: Schema.NullOr(Schema.String),
  error: Schema.NullOr(
    Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      retryable: Schema.Boolean
    })
  ),
  createdAt: Schema.String,
  updatedAt: Schema.String
});
export type VideoJob = typeof VideoJobSchema.Type;

export const VideoEstimateSchema = Schema.Struct({
  modelId: Schema.String,
  currency: Schema.Literal("USD"),
  amount: Schema.NullOr(Schema.Number),
  note: Schema.String
});

export const ModelDefinitionSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  provider: Schema.Literal("ORZ"),
  media: Schema.Literal("video", "image"),
  durations: Schema.Union(Schema.Array(Schema.Number), Schema.Literal("4-15")),
  resolutions: Schema.Array(Schema.Literal("480p", "720p", "1080p")),
  aspectRatios: Schema.Array(Schema.Literal("16:9", "9:16", "1:1", "21:9", "4:3", "3:4"))
});

export const AgentPromptRequestSchema = Schema.Struct({
  projectRoot: Schema.String,
  prompt: Schema.String.pipe(Schema.minLength(1)),
  selectedNodeIds: Schema.Array(Schema.String)
});

export const BriefRestatementRequestSchema = Schema.Struct({
  projectRoot: Schema.String.pipe(Schema.minLength(1))
});

export const CreativeDirectionOptionSchema = Schema.Struct({
  title: Schema.String,
  oneLine: Schema.String,
  hook: Schema.String,
  proof: Schema.String,
  cta: Schema.String
});
export type CreativeDirectionOption = typeof CreativeDirectionOptionSchema.Type;

const WorkflowNodeSummarySchema = Schema.Struct({
  nodeId: Schema.String,
  status: NodeStatusSchema
});

export const AgentWorkflowStateSchema = Schema.Struct({
  brief: Schema.NullOr(WorkflowNodeSummarySchema),
  creative: Schema.NullOr(
    Schema.Struct({
      nodeId: Schema.String,
      status: NodeStatusSchema,
      directions: Schema.Array(CreativeDirectionOptionSchema)
    })
  ),
  script: Schema.NullOr(WorkflowNodeSummarySchema),
  storyboard: Schema.NullOr(
    Schema.Struct({
      nodeId: Schema.String,
      status: NodeStatusSchema,
      imageCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
      shotCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
      overviewReady: Schema.Boolean,
      splitCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative())
    })
  )
});
export type AgentWorkflowState = typeof AgentWorkflowStateSchema.Type;

export const ConfirmBriefRequestSchema = Schema.Struct({
  projectRoot: Schema.String.pipe(Schema.minLength(1))
});

export const GenerateScriptRequestSchema = Schema.Struct({
  projectRoot: Schema.String.pipe(Schema.minLength(1)),
  directionIndex: Schema.Number.pipe(Schema.int(), Schema.between(0, 2)),
  supplement: Schema.String
});

export const GenerateStoryboardRequestSchema = Schema.Struct({
  projectRoot: Schema.String.pipe(Schema.minLength(1))
});

export const GenerateStoryboardImagesRequestSchema = Schema.Struct({
  projectRoot: Schema.String.pipe(Schema.minLength(1)),
  scriptNodeId: Schema.String.pipe(Schema.minLength(1))
});

export const StoryboardImageVersionSchema = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  modelId: Schema.String,
  status: Schema.Literal("generating", "ready", "failed"),
  dataUrl: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String
});
export type StoryboardImageVersion = typeof StoryboardImageVersionSchema.Type;

export const StoryboardImageStateSchema = Schema.Struct({
  nodeId: Schema.String,
  shotId: Schema.String,
  duration: Schema.Number,
  sourceScriptNodeId: Schema.String,
  imageSetId: Schema.String,
  selectedVersionId: Schema.NullOr(Schema.String),
  versions: Schema.Array(StoryboardImageVersionSchema)
});
export type StoryboardImageState = typeof StoryboardImageStateSchema.Type;

export const StoryboardImageNodeRequestSchema = Schema.Struct({
  projectRoot: Schema.String.pipe(Schema.minLength(1)),
  nodeId: Schema.String.pipe(Schema.minLength(1))
});

export const RegenerateStoryboardImageRequestSchema = Schema.Struct({
  projectRoot: Schema.String.pipe(Schema.minLength(1)),
  nodeId: Schema.String.pipe(Schema.minLength(1)),
  prompt: Schema.String.pipe(Schema.minLength(1))
});

export const SelectStoryboardImageVersionRequestSchema = Schema.Struct({
  projectRoot: Schema.String.pipe(Schema.minLength(1)),
  nodeId: Schema.String.pipe(Schema.minLength(1)),
  versionId: Schema.String.pipe(Schema.minLength(1))
});

export const ApplyStoryboardImageRequestSchema = Schema.Struct({
  projectRoot: Schema.String.pipe(Schema.minLength(1)),
  nodeId: Schema.String.pipe(Schema.minLength(1)),
  baseScriptNodeId: Schema.optional(Schema.String.pipe(Schema.minLength(1)))
});

export const GenerateVideoPromptRequestSchema = Schema.Struct({
  projectRoot: Schema.String.pipe(Schema.minLength(1)),
  scriptNodeId: Schema.String.pipe(Schema.minLength(1)),
  imageNodeIds: Schema.Array(Schema.String.pipe(Schema.minLength(1))).pipe(Schema.minItems(1))
});

export const GenerateVideoPromptResultSchema = Schema.Struct({
  prompt: Schema.String,
  scriptNodeId: Schema.String,
  imageNodeIds: Schema.Array(Schema.String),
  referenceImageUrls: Schema.Array(Schema.String),
  duration: Schema.Number,
  shotCount: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
  aspectRatio: AspectRatioSchema
});
export type GenerateVideoPromptResult = typeof GenerateVideoPromptResultSchema.Type;

export const SplitStoryboardOverviewRequestSchema = Schema.Struct({
  projectRoot: Schema.String.pipe(Schema.minLength(1))
});

export const AgentReplySchema = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  createdAt: Schema.String
});
export type AgentReply = typeof AgentReplySchema.Type;

export const AgentUiEventSchema = Schema.Union(
  Schema.Struct({ type: Schema.Literal("agent-start"), requestId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("text-delta"), requestId: Schema.String, delta: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool-start"),
    requestId: Schema.String,
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Unknown
  }),
  Schema.Struct({
    type: Schema.Literal("tool-end"),
    requestId: Schema.String,
    toolCallId: Schema.String,
    toolName: Schema.String,
    result: Schema.Unknown,
    isError: Schema.Boolean
  }),
  Schema.Struct({ type: Schema.Literal("project-changed"), requestId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("agent-end"), requestId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("agent-error"), requestId: Schema.String, message: Schema.String })
);
export type AgentUiEvent = typeof AgentUiEventSchema.Type;

export interface DesktopApi {
  project: {
    create(input: CreateProjectRequest): Promise<ProjectState | null>;
    open(): Promise<ProjectState | null>;
    reload(projectRoot: string): Promise<ProjectState>;
    saveCanvas(input: typeof SaveCanvasRequestSchema.Type): Promise<CanvasSnapshot>;
    readBody(input: typeof ReadBodyRequestSchema.Type): Promise<string>;
    writeBody(input: typeof WriteBodyRequestSchema.Type): Promise<void>;
    createNode(input: typeof CreateNodeRequestSchema.Type): Promise<CanvasNode>;
    updateNodeStatus(input: typeof UpdateNodeStatusRequestSchema.Type): Promise<CanvasNode>;
    deleteNodes(input: typeof DeleteNodesRequestSchema.Type): Promise<DeleteNodesResult>;
  };
  provider: {
    status(): Promise<ProviderStatus>;
    configure(input: ProviderConfiguration): Promise<ProviderStatus>;
    validate(): Promise<ProviderValidation>;
    validateImage(): Promise<ProviderValidation>;
    clear(): Promise<ProviderStatus>;
    openTopUp(): Promise<void>;
  };
  agent: {
    prompt(input: typeof AgentPromptRequestSchema.Type): Promise<AgentReply>;
    restateBrief(input: typeof BriefRestatementRequestSchema.Type): Promise<AgentReply>;
    workflowState(input: typeof BriefRestatementRequestSchema.Type): Promise<AgentWorkflowState>;
    confirmBrief(input: typeof ConfirmBriefRequestSchema.Type): Promise<AgentReply>;
    generateScript(input: typeof GenerateScriptRequestSchema.Type): Promise<AgentReply>;
    generateStoryboardImages(input: typeof GenerateStoryboardImagesRequestSchema.Type): Promise<AgentReply>;
    storyboardImageState(input: typeof StoryboardImageNodeRequestSchema.Type): Promise<StoryboardImageState>;
    regenerateStoryboardImage(input: typeof RegenerateStoryboardImageRequestSchema.Type): Promise<StoryboardImageState>;
    selectStoryboardImageVersion(input: typeof SelectStoryboardImageVersionRequestSchema.Type): Promise<StoryboardImageState>;
    applyStoryboardImage(input: typeof ApplyStoryboardImageRequestSchema.Type): Promise<AgentReply>;
    generateVideoPrompt(input: typeof GenerateVideoPromptRequestSchema.Type): Promise<GenerateVideoPromptResult>;
    splitStoryboardOverview(input: typeof SplitStoryboardOverviewRequestSchema.Type): Promise<AgentReply>;
    onEvent(listener: (event: AgentUiEvent) => void): () => void;
  };
  video: {
    listModels(): Promise<readonly ModelDefinition[]>;
    estimate(input: VideoGenerationRequest): Promise<typeof VideoEstimateSchema.Type>;
    submit(input: VideoGenerationRequest): Promise<VideoJob>;
    cancel(jobId: string): Promise<VideoJob>;
    retry(jobId: string): Promise<VideoJob>;
    getJob(jobId: string): Promise<VideoJob>;
    selectVariant(jobId: string, outputUrl: string): Promise<VideoJob>;
    renderProject(projectRoot: string): Promise<{ outputPath: string }>;
  };
}

export interface ModelDefinition {
  id: string;
  name: string;
  provider: "ORZ";
  media: "video" | "image";
  durations: readonly number[] | "4-15";
  resolutions: readonly ("480p" | "720p" | "1080p")[];
  aspectRatios: readonly ("16:9" | "9:16" | "1:1" | "21:9" | "4:3" | "3:4")[];
}
