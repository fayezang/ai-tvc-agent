import { contextBridge, ipcRenderer } from "electron";
import type { AgentUiEvent, DesktopApi, VideoGenerationRequest } from "../shared/contracts.js";
import { IpcChannels } from "../shared/ipc-channels.js";

const isAgentUiEvent = (input: unknown): input is AgentUiEvent => {
  if (!input || typeof input !== "object") return false;
  const event = input as Record<string, unknown>;
  return (
    typeof event.type === "string" &&
    [
      "agent-start",
      "text-delta",
      "tool-start",
      "tool-end",
      "project-changed",
      "agent-end",
      "agent-error"
    ].includes(event.type) &&
    typeof event.requestId === "string"
  );
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
    updateNodeStatus: (input) => ipcRenderer.invoke(IpcChannels.projectUpdateNodeStatus, input)
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
