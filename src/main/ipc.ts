import { dialog, ipcMain, shell, type BrowserWindow } from "electron";
import { Schema } from "effect";
import {
  AgentPromptRequestSchema,
  AgentWorkflowStateSchema,
  BriefRestatementRequestSchema,
  ConfirmBriefRequestSchema,
  GenerateScriptRequestSchema,
  GenerateStoryboardRequestSchema,
  GenerateStoryboardImagesRequestSchema,
  StoryboardImageNodeRequestSchema,
  RegenerateStoryboardImageRequestSchema,
  SelectStoryboardImageVersionRequestSchema,
  ApplyStoryboardImageRequestSchema,
  GenerateVideoPromptRequestSchema,
  GenerateVideoPromptResultSchema,
  StoryboardImageStateSchema,
  SplitStoryboardOverviewRequestSchema,
  AgentReplySchema,
  AgentUiEventSchema,
  CanvasNodeSchema,
  CanvasSnapshotSchema,
  CreateNodeRequestSchema,
  CreateProjectRequestSchema,
  ModelDefinitionSchema,
  ProviderConfigurationSchema,
  ProviderStatusSchema,
  ProviderValidationSchema,
  ReadBodyRequestSchema,
  SaveCanvasRequestSchema,
  UpdateNodeStatusRequestSchema,
  DeleteNodesRequestSchema,
  DeleteNodesResultSchema,
  VideoEstimateSchema,
  VideoGenerationRequestSchema,
  VideoJobSchema,
  WriteBodyRequestSchema,
  ProjectStateSchema
} from "../shared/contracts.js";
import { IpcChannels } from "../shared/ipc-channels.js";
import { ORZ_TOP_UP_URL } from "../shared/orz-models.js";
import { CredentialStore } from "./credential-store.js";
import { UtilityClient } from "./utility-client.js";

const decode = <A, I>(schema: Schema.Schema<A, I, never>, input: unknown): A =>
  Schema.decodeUnknownSync(schema)(input);

const handle = <Input, InputEncoded, Output, OutputEncoded>(
  channel: string,
  inputSchema: Schema.Schema<Input, InputEncoded, never>,
  outputSchema: Schema.Schema<Output, OutputEncoded, never>,
  handler: (input: Input) => Promise<unknown> | unknown
): void => {
  ipcMain.handle(channel, async (_event, rawInput?: unknown) => {
    const input = decode(inputSchema, rawInput);
    const output = await handler(input);
    return decode(outputSchema, output);
  });
};

export const registerIpc = (window: BrowserWindow, utility: UtilityClient): void => {
  const credentials = new CredentialStore();
  let activeProjectRoot: string | null = null;

  utility.onAgentEvent((event) => {
    window.webContents.send(IpcChannels.agentEvent, decode(AgentUiEventSchema, event));
  });

  handle(IpcChannels.projectCreate, CreateProjectRequestSchema, Schema.NullOr(ProjectStateSchema), async (input) => {
    const selection = await dialog.showOpenDialog(window, {
      title: "选择项目保存位置",
      properties: ["openDirectory", "createDirectory"]
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const result = await utility.call("project.create", { parentPath: selection.filePaths[0], input });
    const project = decode(ProjectStateSchema, result);
    activeProjectRoot = project.project.rootPath;
    return project;
  });

  handle(IpcChannels.projectOpen, Schema.Void, Schema.NullOr(ProjectStateSchema), async () => {
    const selection = await dialog.showOpenDialog(window, {
      title: "打开 AI TVC Agent 项目",
      properties: ["openDirectory"]
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const result = decode(ProjectStateSchema, await utility.call("project.open", { rootPath: selection.filePaths[0] }));
    activeProjectRoot = result.project.rootPath;
    return result;
  });
  handle(IpcChannels.projectReload, Schema.String, ProjectStateSchema, async (projectRoot) => {
    const result = decode(ProjectStateSchema, await utility.call("project.open", { rootPath: projectRoot }));
    activeProjectRoot = result.project.rootPath;
    return result;
  });

  handle(IpcChannels.projectSaveCanvas, SaveCanvasRequestSchema, CanvasSnapshotSchema, (input) =>
    utility.call("project.saveCanvas", input)
  );
  handle(IpcChannels.projectReadBody, ReadBodyRequestSchema, Schema.String, (input) =>
    utility.call("project.readBody", input)
  );
  handle(IpcChannels.projectWriteBody, WriteBodyRequestSchema, Schema.Void, (input) =>
    utility.call("project.writeBody", input)
  );
  handle(IpcChannels.projectCreateNode, CreateNodeRequestSchema, CanvasNodeSchema, (input) =>
    utility.call("project.createNode", input)
  );
  handle(IpcChannels.projectUpdateNodeStatus, UpdateNodeStatusRequestSchema, CanvasNodeSchema, (input) =>
    utility.call("project.updateNodeStatus", input)
  );
  handle(IpcChannels.projectDeleteNodes, DeleteNodesRequestSchema, DeleteNodesResultSchema, (input) =>
    utility.call("project.deleteNodes", input)
  );

  handle(IpcChannels.providerStatus, Schema.Void, ProviderStatusSchema, () => credentials.status());
  handle(IpcChannels.providerConfigure, ProviderConfigurationSchema, ProviderStatusSchema, (input) =>
    credentials.configure(input)
  );
  handle(IpcChannels.providerValidate, Schema.Void, ProviderValidationSchema, () => credentials.validate());
  handle(IpcChannels.providerValidateImage, Schema.Void, ProviderValidationSchema, () =>
    credentials.validateImageModel()
  );
  handle(IpcChannels.providerClear, Schema.Void, ProviderStatusSchema, () => credentials.clear());
  handle(IpcChannels.providerOpenTopUp, Schema.Void, Schema.Void, async () => {
    await shell.openExternal(ORZ_TOP_UP_URL);
  });

  handle(IpcChannels.agentPrompt, AgentPromptRequestSchema, AgentReplySchema, (input) =>
    utility.call("agent.prompt", input, credentials.secrets())
  );
  handle(IpcChannels.agentRestateBrief, BriefRestatementRequestSchema, AgentReplySchema, (input) =>
    utility.call("agent.restateBrief", input, credentials.secrets())
  );
  handle(IpcChannels.agentWorkflowState, BriefRestatementRequestSchema, AgentWorkflowStateSchema, (input) =>
    utility.call("agent.workflowState", input)
  );
  handle(IpcChannels.agentConfirmBrief, ConfirmBriefRequestSchema, AgentReplySchema, (input) =>
    utility.call("agent.confirmBrief", input, credentials.secrets())
  );
  handle(IpcChannels.agentGenerateScript, GenerateScriptRequestSchema, AgentReplySchema, (input) =>
    utility.call("agent.generateScript", input, credentials.secrets())
  );
  handle(IpcChannels.agentGenerateStoryboardImages, GenerateStoryboardImagesRequestSchema, AgentReplySchema, (input) =>
    utility.call("agent.generateStoryboardImages", input, credentials.secrets())
  );
  handle(IpcChannels.agentStoryboardImageState, StoryboardImageNodeRequestSchema, StoryboardImageStateSchema, (input) =>
    utility.call("agent.storyboardImageState", input)
  );
  handle(IpcChannels.agentRegenerateStoryboardImage, RegenerateStoryboardImageRequestSchema, StoryboardImageStateSchema, (input) =>
    utility.call("agent.regenerateStoryboardImage", input, credentials.secrets())
  );
  handle(IpcChannels.agentSelectStoryboardImageVersion, SelectStoryboardImageVersionRequestSchema, StoryboardImageStateSchema, (input) =>
    utility.call("agent.selectStoryboardImageVersion", input)
  );
  handle(IpcChannels.agentApplyStoryboardImage, ApplyStoryboardImageRequestSchema, AgentReplySchema, (input) =>
    utility.call("agent.applyStoryboardImage", input, credentials.secrets())
  );
  handle(IpcChannels.agentGenerateVideoPrompt, GenerateVideoPromptRequestSchema, GenerateVideoPromptResultSchema, (input) =>
    utility.call("agent.generateVideoPrompt", input, credentials.secrets())
  );
  handle(IpcChannels.agentSplitStoryboardOverview, SplitStoryboardOverviewRequestSchema, AgentReplySchema, (input) =>
    utility.call("agent.splitStoryboardOverview", input)
  );

  handle(IpcChannels.videoListModels, Schema.Void, Schema.Array(ModelDefinitionSchema), () =>
    utility.call("video.listModels", {})
  );
  handle(IpcChannels.videoEstimate, VideoGenerationRequestSchema, VideoEstimateSchema, (input) =>
    utility.call("video.estimate", input, credentials.secrets())
  );
  handle(IpcChannels.videoSubmit, VideoGenerationRequestSchema, VideoJobSchema, (input) =>
    utility.call("video.submit", input, credentials.secrets())
  );

  const jobIdSchema = Schema.String.pipe(Schema.minLength(1));
  handle(IpcChannels.videoGetJob, jobIdSchema, VideoJobSchema, (jobId) => {
    if (!activeProjectRoot) throw new Error("请先打开项目");
    return utility.call("video.getJob", { projectRoot: activeProjectRoot, jobId }, credentials.secrets());
  });
  handle(IpcChannels.videoCancel, jobIdSchema, VideoJobSchema, (jobId) => {
    if (!activeProjectRoot) throw new Error("请先打开项目");
    return utility.call("video.cancel", { projectRoot: activeProjectRoot, jobId }, credentials.secrets());
  });
  handle(IpcChannels.videoRetry, jobIdSchema, VideoJobSchema, (jobId) => {
    if (!activeProjectRoot) throw new Error("请先打开项目");
    return utility.call("video.retry", { projectRoot: activeProjectRoot, jobId }, credentials.secrets());
  });
  handle(
    IpcChannels.videoSelectVariant,
    Schema.Struct({ jobId: jobIdSchema, outputUrl: Schema.String }),
    VideoJobSchema,
    ({ jobId, outputUrl }) => {
      if (!activeProjectRoot) throw new Error("请先打开项目");
      return utility.call("video.selectVariant", { projectRoot: activeProjectRoot, jobId, outputUrl });
    }
  );
  handle(
    IpcChannels.videoRenderProject,
    Schema.String,
    Schema.Struct({ outputPath: Schema.String }),
    (projectRoot) => utility.call("video.renderProject", { projectRoot })
  );
};
