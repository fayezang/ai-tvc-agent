import { contextBridge, ipcRenderer } from "electron";
import type { AgentUiEvent, DesktopApi, VideoGenerationRequest } from "../shared/contracts.js";
import { IpcChannels } from "../shared/ipc-channels.js";

/**
 * IPC 边界上的类型守卫。
 *
 * 这里漏掉一个成员，对应的事件会被静默丢弃——没有报错，只是永远不到达
 * renderer。AgentUiEventSchema 每新增一个成员，本白名单必须同步。
 */
const AGENT_EVENT_TYPES = [
  "agent-start",
  "text-delta",
  "tool-start",
  "tool-end",
  "project-changed",
  "agent-end",
  "agent-error",
  "video-job"
] as const;

const isAgentUiEvent = (input: unknown): input is AgentUiEvent => {
  if (!input || typeof input !== "object") return false;
  const event = input as Record<string, unknown>;
  if (typeof event.type !== "string") return false;
  if (!(AGENT_EVENT_TYPES as readonly string[]).includes(event.type)) return false;
  // video-job 由轮询器与启动恢复主动发出，不属于任何一次用户请求，
  // 因此没有 requestId。对它套用 requestId 检查会把它全部挡掉。
  if (event.type === "video-job") return Boolean(event.job) && typeof event.job === "object";
  return typeof event.requestId === "string";
};

const api: DesktopApi = {
  project: {
    create: (input) => ipcRenderer.invoke(IpcChannels.projectCreate, input),
    open: () => ipcRenderer.invoke(IpcChannels.projectOpen),
    reload: (projectRoot) => ipcRenderer.invoke(IpcChannels.projectReload, projectRoot),
    saveCanvas: (input) => ipcRenderer.invoke(IpcChannels.projectSaveCanvas, input),
    readBody: (input) => ipcRenderer.invoke(IpcChannels.projectReadBody, input),
    writeBody: (input) => ipcRenderer.invoke(IpcChannels.projectWriteBody, input),
    createNode: (input) => ipcRenderer.invoke(IpcChannels.projectCreateNode, input),
    updateNodeStatus: (input) => ipcRenderer.invoke(IpcChannels.projectUpdateNodeStatus, input),
    deleteNodes: (input) => ipcRenderer.invoke(IpcChannels.projectDeleteNodes, input)
  },
  provider: {
    status: () => ipcRenderer.invoke(IpcChannels.providerStatus),
    configure: (input) => ipcRenderer.invoke(IpcChannels.providerConfigure, input),
    validate: () => ipcRenderer.invoke(IpcChannels.providerValidate),
    validateImage: () => ipcRenderer.invoke(IpcChannels.providerValidateImage),
    clear: () => ipcRenderer.invoke(IpcChannels.providerClear),
    openTopUp: () => ipcRenderer.invoke(IpcChannels.providerOpenTopUp)
  },
  agent: {
    prompt: (input) => ipcRenderer.invoke(IpcChannels.agentPrompt, input),
    restateBrief: (input) => ipcRenderer.invoke(IpcChannels.agentRestateBrief, input),
    workflowState: (input) => ipcRenderer.invoke(IpcChannels.agentWorkflowState, input),
    confirmBrief: (input) => ipcRenderer.invoke(IpcChannels.agentConfirmBrief, input),
    generateScript: (input) => ipcRenderer.invoke(IpcChannels.agentGenerateScript, input),
    generateStoryboardImages: (input) => ipcRenderer.invoke(IpcChannels.agentGenerateStoryboardImages, input),
    storyboardImageState: (input) => ipcRenderer.invoke(IpcChannels.agentStoryboardImageState, input),
    regenerateStoryboardImage: (input) => ipcRenderer.invoke(IpcChannels.agentRegenerateStoryboardImage, input),
    selectStoryboardImageVersion: (input) => ipcRenderer.invoke(IpcChannels.agentSelectStoryboardImageVersion, input),
    applyStoryboardImage: (input) => ipcRenderer.invoke(IpcChannels.agentApplyStoryboardImage, input),
    generateVideoPrompt: (input) => ipcRenderer.invoke(IpcChannels.agentGenerateVideoPrompt, input),
    splitStoryboardOverview: (input) => ipcRenderer.invoke(IpcChannels.agentSplitStoryboardOverview, input),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
        if (isAgentUiEvent(raw)) listener(raw);
      };
      ipcRenderer.on(IpcChannels.agentEvent, handler);
      return () => ipcRenderer.removeListener(IpcChannels.agentEvent, handler);
    }
  },
  video: {
    listModels: () => ipcRenderer.invoke(IpcChannels.videoListModels),
    estimate: (input: VideoGenerationRequest) => ipcRenderer.invoke(IpcChannels.videoEstimate, input),
    submit: (input: VideoGenerationRequest) => ipcRenderer.invoke(IpcChannels.videoSubmit, input),
    cancel: (jobId) => ipcRenderer.invoke(IpcChannels.videoCancel, jobId),
    retry: (jobId) => ipcRenderer.invoke(IpcChannels.videoRetry, jobId),
    getJob: (jobId) => ipcRenderer.invoke(IpcChannels.videoGetJob, jobId),
    selectVariant: (jobId, outputUrl) =>
      ipcRenderer.invoke(IpcChannels.videoSelectVariant, { jobId, outputUrl }),
    renderProject: (projectRoot) => ipcRenderer.invoke(IpcChannels.videoRenderProject, projectRoot)
  }
};

contextBridge.exposeInMainWorld("agentApp", api);
