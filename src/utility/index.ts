import { MODEL_DEFINITIONS, resolveVideoModelForRole } from "../shared/orz-models.js";
import { estimateVideoCost } from "../shared/video-estimate.js";
import type { ProviderVideoRouting, VideoGenerationRequest, VideoJob } from "../shared/contracts.js";
import { AgentService } from "./agent-service.js";
import { JobService } from "./job-service.js";
import { JobPoller } from "./job-poller.js";
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

const emitEvent = (event: unknown): void => parentPort.postMessage({ type: "event", event });

const emitJob = (job: VideoJob): void => emitEvent({ type: "video-job", job });

/**
 * 轮询在 Utility Process 内进行，因此与窗口生命周期无关：
 * 用户关掉面板甚至关掉窗口，任务仍被持续跟踪，重新打开即看到最新状态。
 *
 * API Key 在 track 时捕获而非每次轮询重新索取：轮询是后台行为，
 * 拿不到当次请求的 secrets。Key 变更后新提交的任务会用新的 Key。
 */
const createPoller = (apiKey: string): JobPoller =>
  new JobPoller({
    refresh: (projectRoot, jobId) => jobService.refresh(projectRoot, jobId, apiKey),
    emit: emitJob,
    onError: (jobId, error) =>
      emitEvent({
        type: "agent-error",
        requestId: `poll-${jobId}`,
        message: `查询视频任务状态失败：${error instanceof Error ? error.message : "未知错误"}`
      })
  });

/**
 * 每个 API Key 一个轮询器实例，避免 Key 变更后旧任务继续用失效的 Key 查询。
 * 实际使用中通常只有一个 Key，因此这个 Map 几乎总是只有一项。
 */
const pollers = new Map<string, JobPoller>();

const pollerFor = (apiKey: string): JobPoller => {
  const existing = pollers.get(apiKey);
  if (existing) return existing;
  const poller = createPoller(apiKey);
  pollers.set(apiKey, poller);
  return poller;
};

const trackJob = (apiKey: string | null, projectRoot: string, job: VideoJob): VideoJob => {
  if (apiKey) pollerFor(apiKey).track(projectRoot, job);
  return job;
};

const handle = async (request: UtilityRequest): Promise<unknown> => {
  const payload = request.payload as Record<string, any>;
  switch (request.method) {
    case "project.create":
      return projectService.create(payload.parentPath, payload.input);
    case "project.open": {
      const state = await projectService.open(payload.rootPath);
      const apiKey = request.secrets?.apiKey ?? null;
      // 打开项目时把上次运行遗留的悬空任务重新纳入跟踪。
      //
      // 不 await：恢复要向 ORZ 逐个查询，慢的话会把打开项目这个动作
      // 一起拖住。分诊本身是同步落库的，因此即使查询还没回来，
      // 数据库里的状态也已经是真实的了。
      //
      // 没有 API Key 时依然要跑：分诊会把悬空任务标为 interrupted，
      // 用户至少能看见它们，而不是对着一个永远停在 generating 的界面。
      void jobService
        .recoverInterrupted(payload.rootPath, apiKey, emitJob)
        .then((result) => {
          // 恢复后仍未结束的任务交给轮询器，否则它们只会被查这一次，
          // 然后再次失联到下一次启动。
          for (const job of result.recovered) trackJob(apiKey, payload.rootPath, job);
        })
        .catch((error: unknown) => {
          emitEvent({
            type: "agent-error",
            requestId: request.id,
            message: `恢复上次未完成的视频任务时出错：${
              error instanceof Error ? error.message : "未知错误"
            }`
          });
        });
      return state;
    }
    case "project.saveCanvas":
      // 走合并路径：renderer 的快照因防抖而滞后，
      // 直接覆盖会抹掉后台在这段间隙里新建的节点。
      return projectService.saveCanvasFromClient(payload.projectRoot, payload.canvas);
    case "project.readBody":
      return projectService.readBody(payload.projectRoot, payload.bodyPath);
    case "project.writeBody":
      return projectService.writeBody(payload.projectRoot, payload.bodyPath, payload.markdown);
    case "project.createNode":
      return projectService.createNode(payload.projectRoot, payload.kind, payload.position);
    case "project.updateNodeStatus":
      return projectService.updateNodeStatus(payload.projectRoot, payload.nodeId, payload.status);
    case "project.deleteNodes":
      return projectService.deleteNodes(payload.projectRoot, payload.nodeIds);
    case "video.listModels":
      return MODEL_DEFINITIONS;
    case "video.estimate": {
      // 估价是纯函数，不发任何网络请求，因此提交前可以反复调用。
      // 模型由角色路由决定，不采用调用方自带的 modelId。
      const generation = request.payload as VideoGenerationRequest;
      return estimateVideoCost({
        ...generation,
        modelId: resolveVideoModelForRole(generation.role, request.secrets?.videoModelRouting)
      });
    }
    case "video.prepare": {
      const generation = request.payload as VideoGenerationRequest;
      // 模型由角色路由决定，不采用调用方自带的 modelId。
      // 本分支刻意不调 requireApiKey：准备阶段不发网络请求，
      // 用户能在真正花钱前先看到这一镜的报价。
      return jobService.prepare({
        ...generation,
        modelId: resolveVideoModelForRole(generation.role, request.secrets?.videoModelRouting)
      });
    }
    case "video.approve": {
      const apiKey = requireApiKey(request);
      const job = await jobService.approve(payload.projectRoot, payload.jobId, apiKey);
      return trackJob(apiKey, payload.projectRoot, job);
    }
    case "video.discard":
      // 服务端从来不知道待确认任务存在，因此无需 API Key。
      return jobService.discard(payload.projectRoot, payload.jobId);
    case "video.getJob":
      return jobService.refresh(payload.projectRoot, payload.jobId, requireApiKey(request));
    case "video.cancel": {
      const job = await jobService.cancel(payload.projectRoot, payload.jobId, requireApiKey(request));
      // 已取消的任务不必再查。留着只会白白消耗请求配额。
      for (const poller of pollers.values()) poller.stop(payload.jobId);
      return job;
    }
    case "video.retry":
      // 重试同样可能计费，因此只建待确认尝试；真正提交仍走 approve。
      return jobService.retry(payload.projectRoot, payload.jobId);
    case "video.selectVariant":
      return jobService.selectVariant(payload.projectRoot, payload.jobId, payload.outputUrl);
    case "video.chain":
      return jobService.chain(payload.projectRoot, payload.jobId);
    case "video.exportCompleted":
      return jobService.exportCompleted(payload.projectRoot, payload.jobId, payload.destinationPath);
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
    case "agent.applyStoryboardImage":
      // 只复制最新脚本并替换第三列 Prompt；纯本地操作，不需要模型或 API Key。
      return agentService.applyStoryboardImage({
        projectRoot: payload.projectRoot,
        nodeId: payload.nodeId
      });
    case "agent.generateVideoPrompt": {
      const textModelId = request.secrets?.textModelId;
      if (!textModelId) throw new Error("请先设置 ORZ 文本模型 ID");
      return agentService.generateVideoPrompt({
        projectRoot: payload.projectRoot,
        scriptNodeId: payload.scriptNodeId,
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

// 进程退出前停掉全部轮询，避免留下悬空定时器让进程迟迟不退出。
process.on("exit", () => {
  for (const poller of pollers.values()) poller.stopAll();
});

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
