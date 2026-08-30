import { MODEL_DEFINITIONS, resolveVideoModelForRole } from "../shared/orz-models.js";
import type { ProviderVideoRouting, VideoGenerationRequest } from "../shared/contracts.js";
import { AgentService } from "./agent-service.js";
import { JobService } from "./job-service.js";
import { ProjectService } from "./project-service.js";

interface UtilityRequest {
  id: string;
  method: string;
  payload: unknown;
  secrets?: {
    apiKey?: string;
    textModelId?: string;
    imageModelId?: string;
    videoModelRouting?: ProviderVideoRouting;
  };
}

interface UtilityResponse {
  id: string;
  result?: unknown;
  error?: string;
}

interface ParentPortMessageEvent {
  data: UtilityRequest;
}

const projectService = new ProjectService();
const jobService = new JobService();
const agentService = new AgentService(projectService);
const parentPort = process.parentPort;

if (!parentPort) throw new Error("Utility Process 缺少 parentPort");

const requireApiKey = (request: UtilityRequest): string => {
  const apiKey = request.secrets?.apiKey;
  if (!apiKey) throw new Error("请先在 ORZ 设置中保存 API Key");
  return apiKey;
};

const handle = async (request: UtilityRequest): Promise<unknown> => {
  const payload = request.payload as Record<string, any>;
  switch (request.method) {
    case "project.create":
      return projectService.create(payload.parentPath, payload.input);
    case "project.open":
      return projectService.open(payload.rootPath);
    case "project.saveCanvas":
      return projectService.saveCanvas(payload.projectRoot, payload.canvas);
    case "project.readBody":
      return projectService.readBody(payload.projectRoot, payload.bodyPath);
    case "project.writeBody":
      return projectService.writeBody(payload.projectRoot, payload.bodyPath, payload.markdown);
    case "project.createNode":
      return projectService.createNode(payload.projectRoot, payload.kind, payload.position);
    case "project.updateNodeStatus":
      return projectService.updateNodeStatus(payload.projectRoot, payload.nodeId, payload.status);
    case "video.listModels":
      return MODEL_DEFINITIONS;
    case "video.estimate":
      return {
        modelId: resolveVideoModelForRole(payload.role, request.secrets?.videoModelRouting),
        currency: "USD",
        amount: null,
        note: "ORZ 价格可能变化；提交前以 ORZ 控制台的实时计费为准。"
      };
    case "video.submit": {
      const generation = request.payload as VideoGenerationRequest;
      const configuredRequest: VideoGenerationRequest = {
        ...generation,
        modelId: resolveVideoModelForRole(generation.role, request.secrets?.videoModelRouting)
      };
      return jobService.submit(configuredRequest, requireApiKey(request));
    }
    case "video.getJob":
      return jobService.refresh(payload.projectRoot, payload.jobId, requireApiKey(request));
    case "video.cancel":
      return jobService.cancel(payload.projectRoot, payload.jobId, requireApiKey(request));
    case "video.retry":
      return jobService.retry(payload.projectRoot, payload.jobId, requireApiKey(request));
    case "video.selectVariant":
      return jobService.selectVariant(payload.projectRoot, payload.jobId, payload.outputUrl);
    case "video.renderProject":
      throw new Error("基础 MP4 合成将在视频生成闭环阶段启用；当前未执行任何伪导出。 ");
    case "agent.prompt": {
      const textModelId = request.secrets?.textModelId;
      if (!textModelId) throw new Error("请先设置 ORZ 文本模型 ID");
      const agentPayload = request.payload as {
        projectRoot: string;
        prompt: string;
        selectedNodeIds: readonly string[];
      };
      const selectedContext = await projectService.selectedContext(agentPayload.projectRoot, agentPayload.selectedNodeIds);
      return agentService.prompt({
        ...agentPayload,
        selectedContext,
        apiKey: requireApiKey(request),
        textModelId,
        requestId: request.id,
        emit: (event) => parentPort.postMessage({ type: "event", event })
      });
    }
    case "agent.restateBrief": {
      const textModelId = request.secrets?.textModelId;
      if (!textModelId) throw new Error("请先设置 ORZ 文本模型 ID");
      return agentService.restateBrief({
        projectRoot: payload.projectRoot,
        apiKey: requireApiKey(request),
        textModelId
      });
    }
    case "agent.workflowState":
      return agentService.workflowState(payload.projectRoot);
    case "agent.confirmBrief": {
      const textModelId = request.secrets?.textModelId;
      if (!textModelId) throw new Error("请先设置 ORZ 文本模型 ID");
      return agentService.confirmBrief({
        projectRoot: payload.projectRoot,
        apiKey: requireApiKey(request),
        textModelId
      });
    }
    case "agent.generateScript": {
      const textModelId = request.secrets?.textModelId;
      if (!textModelId) throw new Error("请先设置 ORZ 文本模型 ID");
      return agentService.generateScript({
        projectRoot: payload.projectRoot,
        directionIndex: payload.directionIndex,
        supplement: payload.supplement,
        apiKey: requireApiKey(request),
        textModelId
      });
    }
    case "agent.generateStoryboardImages": {
      const imageModelId = request.secrets?.imageModelId;
      if (!imageModelId) throw new Error("请先在模型与 API 设置中选择图片模型");
      return agentService.generateStoryboardImages({
        projectRoot: payload.projectRoot,
        scriptNodeId: payload.scriptNodeId,
        apiKey: requireApiKey(request),
        imageModelId
      });
    }
    case "agent.storyboardImageState":
      return agentService.storyboardImageState({
        projectRoot: payload.projectRoot,
        nodeId: payload.nodeId
      });
    case "agent.regenerateStoryboardImage": {
      const imageModelId = request.secrets?.imageModelId;
      if (!imageModelId) throw new Error("请先在模型与 API 设置中选择图片模型");
      return agentService.regenerateStoryboardImage({
        projectRoot: payload.projectRoot,
        nodeId: payload.nodeId,
        prompt: payload.prompt,
        apiKey: requireApiKey(request),
        imageModelId
      });
    }
    case "agent.selectStoryboardImageVersion":
      return agentService.selectStoryboardImageVersion({
        projectRoot: payload.projectRoot,
        nodeId: payload.nodeId,
        versionId: payload.versionId
      });
    case "agent.applyStoryboardImage": {
      const textModelId = request.secrets?.textModelId;
      if (!textModelId) throw new Error("请先设置 ORZ 文本模型 ID");
      return agentService.applyStoryboardImage({
        projectRoot: payload.projectRoot,
        nodeId: payload.nodeId,
        ...(payload.baseScriptNodeId ? { baseScriptNodeId: payload.baseScriptNodeId } : {}),
        apiKey: requireApiKey(request),
        textModelId
      });
    }
    case "agent.generateVideoPrompt": {
      const textModelId = request.secrets?.textModelId;
      if (!textModelId) throw new Error("请先设置 ORZ 文本模型 ID");
      return agentService.generateVideoPrompt({
        projectRoot: payload.projectRoot,
        scriptNodeId: payload.scriptNodeId,
        imageNodeIds: payload.imageNodeIds,
        apiKey: requireApiKey(request),
        textModelId
      });
    }
    case "agent.splitStoryboardOverview":
      return agentService.splitStoryboardOverview({ projectRoot: payload.projectRoot });
    default:
      throw new Error(`未知 Utility 方法：${request.method}`);
  }
};

parentPort.on("message", (event: ParentPortMessageEvent) => {
  const request = event.data;
  void handle(request)
    .then((result) => parentPort.postMessage({ id: request.id, result } satisfies UtilityResponse))
    .catch((error: unknown) =>
      parentPort.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : "Utility Process 未知错误"
      } satisfies UtilityResponse)
    );
});
