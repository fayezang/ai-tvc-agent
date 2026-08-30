import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  makeAssistantToolUI,
  useExternalStoreRuntime,
  type ThreadMessageLike
} from "@assistant-ui/react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ArrowUp, Check, Circle, Film, LoaderCircle, PanelRightClose, RefreshCw, Sparkles } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type { AgentWorkflowState, CanvasNode, GenerateVideoPromptResult, VideoJob } from "@shared/contracts";
import { useUiStore } from "../store/ui-store";
import { Button } from "./ui/button";

type ToolJsonValue = string | number | boolean | null | ToolJsonValue[] | { readonly [key: string]: ToolJsonValue };
type ToolArgs = { readonly [key: string]: ToolJsonValue };

interface AgentMessageRecord {
  id: string;
  role: "user" | "assistant";
  text: string;
  tool?: {
    toolCallId: string;
    toolName: string;
    args: ToolArgs;
    result?: unknown;
    isError?: boolean;
  };
}

const convertMessage = (message: AgentMessageRecord): ThreadMessageLike => {
  if (message.tool) {
    return {
      id: message.id,
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: message.tool.toolCallId,
          toolName: message.tool.toolName,
          args: message.tool.args,
          argsText: JSON.stringify(message.tool.args),
          result: message.tool.result,
          isError: message.tool.isError
        }
      ]
    };
  }
  return {
    id: message.id,
    role: message.role,
    content: [{ type: "text", text: message.text }]
  };
};

const asToolArgs = (input: unknown): ToolArgs => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return JSON.parse(JSON.stringify(input)) as ToolArgs;
};

const cleanRemoteError = (error: unknown): string =>
  (error instanceof Error ? error.message : "未知错误").replace(
    /^Error invoking remote method '[^']+':\s*Error:\s*/i,
    ""
  );

const TextPart = (): React.JSX.Element => <MessagePartPrimitive.Text />;
const partComponents = { Text: TextPart };

const VideoGenerationToolUI = makeAssistantToolUI<
  { shotId?: string; modelId?: string },
  { state?: string; outputUrl?: string }
>({
  toolName: "generate_video",
  display: "standalone",
  render: ({ args, result, status, isError }) => (
    <div className="my-2 rounded-xl border border-[var(--border)] bg-[var(--canvas)] p-3 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">生成视频 · {args.shotId ?? "镜头"}</span>
        <span className={isError ? "text-[var(--danger)]" : "text-[var(--muted)]"}>
          {isError ? "失败" : result?.state ?? (status.type === "running" ? "运行中" : status.type)}
        </span>
      </div>
      {args.modelId ? <p className="mt-1 font-mono text-[10px] text-[var(--muted)]">{args.modelId}</p> : null}
    </div>
  )
});

const StoryboardToolUI = makeAssistantToolUI<
  { shotId?: string; prompt?: string },
  { state?: string }
>({
  toolName: "generate_storyboard",
  display: "standalone",
  render: ({ args, result, status, isError }) => (
    <div className="my-2 rounded-xl border border-[var(--border)] bg-[var(--canvas)] p-3 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">生成静态分镜 · {args.shotId ?? "镜头"}</span>
        <span className={isError ? "text-[var(--danger)]" : "text-[var(--muted)]"}>
          {isError ? "失败" : result?.state ?? (status.type === "running" ? "运行中" : status.type)}
        </span>
      </div>
      {args.prompt ? <p className="mt-1 line-clamp-2 text-[var(--muted)]">{args.prompt}</p> : null}
    </div>
  )
});

const CreativeDirectionsToolUI = makeAssistantToolUI<
  { directions?: ReadonlyArray<{ title?: string }> },
  unknown
>({
  toolName: "create_creative_directions",
  display: "standalone",
  render: ({ args, status, isError }) => (
    <div className="my-2 rounded-xl border border-[var(--border)] bg-[var(--canvas)] p-3 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">创建 3 个创意方向</span>
        <span className={isError ? "text-[var(--danger)]" : "text-[var(--muted)]"}>
          {isError ? "校验失败" : status.type === "running" ? "正在写入项目" : "已写入 · 待确认"}
        </span>
      </div>
      <p className="mt-1 text-[var(--muted)]">
        {args.directions?.map((direction) => direction.title).filter(Boolean).join(" · ") || "正在组织差异化方向"}
      </p>
    </div>
  )
});

const ScriptToolUI = makeAssistantToolUI<
  { selectedDirection?: string; shots?: ReadonlyArray<{ duration?: number }> },
  unknown
>({
  toolName: "create_script",
  display: "standalone",
  render: ({ args, status, isError }) => (
    <div className="my-2 rounded-xl border border-[var(--border)] bg-[var(--canvas)] p-3 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">创建结构化脚本</span>
        <span className={isError ? "text-[var(--danger)]" : "text-[var(--muted)]"}>
          {isError ? "时长或字段校验失败" : status.type === "running" ? "校验并写入" : "已写入 · 待确认"}
        </span>
      </div>
      <p className="mt-1 text-[var(--muted)]">
        {args.selectedDirection || "已选方向"} · {args.shots?.length ?? 0} 个镜头 · {args.shots?.reduce((sum, shot) => sum + (shot.duration ?? 0), 0) ?? 0} 秒
      </p>
    </div>
  )
});

const UserMessage = (): React.JSX.Element => (
  <MessagePrimitive.Root className="ml-10 flex justify-end py-2">
    <div className="max-w-[92%] rounded-2xl rounded-br-md bg-[var(--accent)] px-3.5 py-2.5 text-sm leading-6 text-[var(--accent-foreground)]">
      <MessagePrimitive.Parts components={partComponents} />
    </div>
  </MessagePrimitive.Root>
);

const AssistantMessage = (): React.JSX.Element => (
  <MessagePrimitive.Root className="mr-4 py-2">
    <div className="agent-message text-sm leading-6 text-[var(--text)]">
      <MessagePrimitive.Parts components={partComponents} />
    </div>
  </MessagePrimitive.Root>
);

interface AgentPanelProps {
  projectRoot: string;
  canvasNodes: readonly CanvasNode[];
  initialNotice?: string | undefined;
  onProjectChanged(): Promise<void> | void;
}

export function AgentPanel({ projectRoot, canvasNodes, initialNotice, onProjectChanged }: AgentPanelProps): React.JSX.Element {
  const width = useUiStore((state) => state.agentPanelWidth);
  const setWidth = useUiStore((state) => state.setAgentPanelWidth);
  const setOpen = useUiStore((state) => state.setAgentPanelOpen);
  const selectedNodeIds = useUiStore((state) => state.selectedNodeIds);
  const reducedMotion = useReducedMotion();
  const [messages, setMessages] = useState<AgentMessageRecord[]>([
    {
      id: crypto.randomUUID(),
      role: "assistant",
      text:
        initialNotice ??
        "请检查“我理解的 Brief”。需要修改时可直接编辑卡片；确认与创意选择都使用下方结构化操作卡完成。"
    }
  ]);
  const [isRunning, setIsRunning] = useState(false);
  const [workflowState, setWorkflowState] = useState<AgentWorkflowState | null>(null);
  const [workflowBusy, setWorkflowBusy] = useState<
    "brief" | "script" | "storyboard-images" | "video-prompt" | "video-submit" | null
  >(null);
  const [workflowError, setWorkflowError] = useState("");
  const [selectedDirectionIndex, setSelectedDirectionIndex] = useState<number | null>(null);
  const [directionSupplement, setDirectionSupplement] = useState("");
  const [videoPromptResult, setVideoPromptResult] = useState<GenerateVideoPromptResult | null>(null);
  const [videoPromptDraft, setVideoPromptDraft] = useState("");
  const [videoJob, setVideoJob] = useState<VideoJob | null>(null);
  const streamingId = useRef<string | null>(null);
  const workflowLoadId = useRef(0);
  const selectedNodes = useMemo(
    () => canvasNodes.filter((node) => selectedNodeIds.includes(node.id)),
    [canvasNodes, selectedNodeIds]
  );
  const latestScript = useMemo(
    () => [...canvasNodes]
      .filter((node) => node.kind === "script")
      .sort((a, b) => (b.scriptVersion ?? 1) - (a.scriptVersion ?? 1))[0],
    [canvasNodes]
  );
  const selectedScripts = useMemo(
    () => selectedNodes.filter((node) => node.kind === "script"),
    [selectedNodes]
  );
  const selectedFrames = useMemo(
    () => selectedNodes.filter((node) => node.kind === "storyboard-frame"),
    [selectedNodes]
  );
  const activeScript = selectedScripts.length === 1
    ? selectedScripts[0]
    : selectedScripts.length > 1
      ? undefined
      : latestScript;
  const needsBriefRestatement = useMemo(
    () => canvasNodes.some((node) => node.kind === "brief" && node.status === "draft"),
    [canvasNodes]
  );
  const loadWorkflowState = useCallback(async (): Promise<void> => {
    const loadId = ++workflowLoadId.current;
    const next = await window.agentApp.agent.workflowState({ projectRoot });
    if (loadId === workflowLoadId.current) setWorkflowState(next);
  }, [projectRoot]);

  useEffect(() => {
    void loadWorkflowState().catch((error: unknown) => setWorkflowError(cleanRemoteError(error)));
  }, [canvasNodes, loadWorkflowState]);

  useEffect(() => {
    setSelectedDirectionIndex(null);
    setDirectionSupplement("");
  }, [workflowState?.creative?.nodeId]);

  useEffect(() => {
    if (!videoJob || ["completed", "failed", "canceled", "expired"].includes(videoJob.state)) return;
    const timer = window.setInterval(() => {
      void window.agentApp.video.getJob(videoJob.id)
        .then(setVideoJob)
        .catch((error: unknown) => setWorkflowError(cleanRemoteError(error)));
    }, 3000);
    return () => window.clearInterval(timer);
  }, [videoJob]);

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    isRunning,
    onNew: async () => {}
  });

  const editor = useEditor({
    extensions: [StarterKit],
    content: "",
    editorProps: {
      attributes: {
        class: "agent-composer-editor",
        "aria-label": "向 Agent 发送消息"
      },
      handleKeyDown: (_view, event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          void submit();
          return true;
        }
        return false;
      }
    }
  });

  useEffect(
    () =>
      window.agentApp.agent.onEvent((event) => {
      if (event.type === "text-delta") {
        setMessages((current) =>
          current.map((message) =>
            message.id === streamingId.current ? { ...message, text: message.text + event.delta } : message
          )
        );
      }
      if (event.type === "tool-start") {
        setMessages((current) => [
          ...current,
          {
            id: event.toolCallId,
            role: "assistant",
            text: "",
            tool: {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: asToolArgs(event.args)
            }
          }
        ]);
      }
      if (event.type === "tool-end") {
        setMessages((current) =>
          current.map((message) =>
            message.tool?.toolCallId === event.toolCallId
              ? {
                  ...message,
                  tool: { ...message.tool, result: event.result, isError: event.isError }
                }
              : message
          )
        );
      }
      if (event.type === "project-changed") void onProjectChanged();
      }),
    [onProjectChanged]
  );

  const submit = async (): Promise<void> => {
    const prompt = editor?.getText().trim() ?? "";
    if (!prompt || isRunning) return;
    const userMessage: AgentMessageRecord = { id: crypto.randomUUID(), role: "user", text: prompt };
    const assistantId = crypto.randomUUID();
    setMessages((current) => [...current, userMessage, { id: assistantId, role: "assistant", text: "" }]);
    streamingId.current = assistantId;
    setIsRunning(true);
    editor?.commands.clearContent();
    try {
      const reply = await window.agentApp.agent.prompt({
        projectRoot,
        prompt,
        selectedNodeIds
      });
      setMessages((current) =>
        current.map((message) => (message.id === assistantId ? { ...message, text: reply.text } : message))
      );
    } catch (error) {
      const errorMessage = (error instanceof Error ? error.message : "未知错误").replace(
        /^Error invoking remote method '[^']+':\s*Error:\s*/i,
        ""
      );
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? { ...message, text: `运行失败：${errorMessage}` }
            : message
        )
      );
    } finally {
      setIsRunning(false);
      streamingId.current = null;
    }
  };

  const retryBriefRestatement = async (): Promise<void> => {
    if (isRunning) return;
    const assistantId = crypto.randomUUID();
    setMessages((current) => [
      ...current,
      { id: assistantId, role: "assistant", text: "正在使用已保存的文本模型重新复述 Brief…" }
    ]);
    setIsRunning(true);
    try {
      const reply = await window.agentApp.agent.restateBrief({ projectRoot });
      setMessages((current) =>
        current.map((message) => (message.id === assistantId ? { ...message, text: reply.text } : message))
      );
      await onProjectChanged();
    } catch (error) {
      const errorMessage = (error instanceof Error ? error.message : "未知错误").replace(
        /^Error invoking remote method '[^']+':\s*Error:\s*/i,
        ""
      );
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId ? { ...message, text: `重新生成失败：${errorMessage}` } : message
        )
      );
    } finally {
      setIsRunning(false);
    }
  };

  const confirmBriefAndGenerateDirections = async (): Promise<void> => {
    if (isRunning || workflowBusy) return;
    const assistantId = crypto.randomUUID();
    setWorkflowBusy("brief");
    setWorkflowError("");
    setIsRunning(true);
    setMessages((current) => [
      ...current,
      { id: assistantId, role: "assistant", text: "Brief 已确认，正在生成 3 个创意方向…" }
    ]);
    try {
      const reply = await window.agentApp.agent.confirmBrief({ projectRoot });
      setMessages((current) =>
        current.map((message) => (message.id === assistantId ? { ...message, text: reply.text } : message))
      );
      await onProjectChanged();
      await loadWorkflowState();
    } catch (error) {
      const message = cleanRemoteError(error);
      setWorkflowError(message);
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantId ? { ...item, text: `生成创意方向失败：${message}` } : item
        )
      );
    } finally {
      setWorkflowBusy(null);
      setIsRunning(false);
    }
  };

  const generateScriptFromSelection = async (): Promise<void> => {
    if (selectedDirectionIndex === null || isRunning || workflowBusy) return;
    const direction = workflowState?.creative?.directions[selectedDirectionIndex];
    if (!direction) return;
    const assistantId = crypto.randomUUID();
    setWorkflowBusy("script");
    setWorkflowError("");
    setIsRunning(true);
    setMessages((current) => [
      ...current,
      {
        id: assistantId,
        role: "assistant",
        text: `已选择“${direction.title}”，正在直接生成结构化脚本…`
      }
    ]);
    try {
      const reply = await window.agentApp.agent.generateScript({
        projectRoot,
        directionIndex: selectedDirectionIndex,
        supplement: directionSupplement
      });
      setMessages((current) =>
        current.map((message) => (message.id === assistantId ? { ...message, text: reply.text } : message))
      );
      await onProjectChanged();
      await loadWorkflowState();
    } catch (error) {
      const message = cleanRemoteError(error);
      setWorkflowError(message);
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantId ? { ...item, text: `生成脚本失败：${message}` } : item
        )
      );
    } finally {
      setWorkflowBusy(null);
      setIsRunning(false);
    }
  };

  const generateStoryboardImages = async (): Promise<void> => {
    if (!activeScript || isRunning || workflowBusy) return;
    const assistantId = crypto.randomUUID();
    setWorkflowBusy("storyboard-images");
    setWorkflowError("");
    setIsRunning(true);
    setMessages((current) => [
      ...current,
      {
        id: assistantId,
        role: "assistant",
        text: `已确认${activeScript.title}，正在逐行使用第三列英文 Prompt 生成独立静态效果图…`
      }
    ]);
    try {
      const reply = await window.agentApp.agent.generateStoryboardImages({
        projectRoot,
        scriptNodeId: activeScript.id
      });
      setMessages((current) =>
        current.map((message) => (message.id === assistantId ? { ...message, text: reply.text } : message))
      );
      await onProjectChanged();
      await loadWorkflowState();
    } catch (error) {
      const message = cleanRemoteError(error);
      setWorkflowError(message);
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantId ? { ...item, text: `生成静态分镜失败：${message}` } : item
        )
      );
    } finally {
      setWorkflowBusy(null);
      setIsRunning(false);
    }
  };

  const generateFullVideoPrompt = async (): Promise<void> => {
    if (!activeScript || selectedFrames.length === 0 || isRunning || workflowBusy) return;
    const assistantId = crypto.randomUUID();
    setWorkflowBusy("video-prompt");
    setWorkflowError("");
    setIsRunning(true);
    setMessages((current) => [
      ...current,
      { id: assistantId, role: "assistant", text: `正在读取 ${selectedFrames.length} 张实际图片并合成为完整视频 Prompt…` }
    ]);
    try {
      const result = await window.agentApp.agent.generateVideoPrompt({
        projectRoot,
        scriptNodeId: activeScript.id,
        imageNodeIds: selectedFrames.map((node) => node.id)
      });
      setVideoPromptResult(result);
      setVideoPromptDraft(result.prompt);
      setVideoJob(null);
      setMessages((current) => current.map((message) =>
        message.id === assistantId
          ? { ...message, text: "完整视频 Prompt 已生成并显示在下方。你可以编辑，确认后才会提交付费视频生成任务。" }
          : message
      ));
    } catch (error) {
      const message = cleanRemoteError(error);
      setWorkflowError(message);
      setMessages((current) => current.map((item) =>
        item.id === assistantId ? { ...item, text: `生成完整视频 Prompt 失败：${message}` } : item
      ));
    } finally {
      setWorkflowBusy(null);
      setIsRunning(false);
    }
  };

  const submitFullVideo = async (): Promise<void> => {
    if (!videoPromptResult || !videoPromptDraft.trim() || isRunning || workflowBusy) return;
    setWorkflowBusy("video-submit");
    setWorkflowError("");
    setIsRunning(true);
    try {
      const job = await window.agentApp.video.submit({
        projectRoot,
        shotId: `complete-${videoPromptResult.scriptNodeId}`,
        role: "other",
        modelId: "bytedance/seedance-2",
        prompt: videoPromptDraft.trim(),
        duration: videoPromptResult.duration,
        aspectRatio: videoPromptResult.aspectRatio,
        resolution: "1080p",
        referenceImageUrls: videoPromptResult.referenceImageUrls,
        referenceVideoUrls: [],
        referenceAudioUrls: [],
        generateAudio: true
      });
      setVideoJob(job);
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: "已确认并提交完整视频生成。模型将生成原生声音，并按 Prompt 尽量逐字朗读 VO。"
        }
      ]);
    } catch (error) {
      setWorkflowError(cleanRemoteError(error));
    } finally {
      setWorkflowBusy(null);
      setIsRunning(false);
    }
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (moveEvent: PointerEvent): void => setWidth(startWidth + startX - moveEvent.clientX);
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const creativeDirections = workflowState?.creative?.directions ?? [];
  const showDirectionSelection = Boolean(
    workflowState?.creative && creativeDirections.length === 3 && !workflowState.script
  );
  const showBriefConfirmation = Boolean(
    !needsBriefRestatement &&
    workflowState?.brief &&
    !workflowState.script &&
    (!workflowState.creative || creativeDirections.length !== 3)
  );

  return (
    <motion.aside
      initial={reducedMotion ? false : { opacity: 0, x: 18 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.2 }}
      style={{ width }}
      className="relative z-20 grid shrink-0 grid-rows-[56px_1fr_auto] border-l border-[var(--border)] bg-[var(--surface)]"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={startResize}
        className="absolute -left-1 top-0 z-30 h-full w-2 cursor-col-resize"
      />
      <header className="flex items-center justify-between border-b border-[var(--border)] px-4">
        <div>
          <h2 className="text-sm font-semibold">Agent</h2>
          <p className="text-[11px] text-[var(--muted)]">
            {selectedNodes.length > 0 ? `${selectedNodes.length} 个节点作为强上下文` : "整个项目作为上下文"}
          </p>
        </div>
        <Button variant="ghost" size="icon" aria-label="收起 Agent" onClick={() => setOpen(false)}>
          <PanelRightClose className="size-4" />
        </Button>
      </header>

      <AssistantRuntimeProvider runtime={runtime}>
        <VideoGenerationToolUI />
        <StoryboardToolUI />
        <CreativeDirectionsToolUI />
        <ScriptToolUI />
        <ThreadPrimitive.Root className="min-h-0">
          <ThreadPrimitive.Viewport className="h-full overflow-y-auto px-4 py-3">
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>

      <footer className="max-h-[72vh] overflow-y-auto border-t border-[var(--border)] p-3">
        {needsBriefRestatement ? (
          <Button
            variant="outline"
            className="mb-2 w-full"
            disabled={isRunning}
            onClick={() => void retryBriefRestatement()}
          >
            {isRunning ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            重新生成 Brief 复述
          </Button>
        ) : null}
        {showBriefConfirmation ? (
          <section className="mb-3 rounded-xl border border-[var(--border)] bg-[var(--canvas)] p-3">
            <div className="flex items-start gap-2.5">
              <Sparkles className="mt-0.5 size-4 shrink-0 text-[var(--accent)]" />
              <div>
                <h3 className="text-sm font-medium">确认我理解的 Brief</h3>
                <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
                  确认后立即生成 3 个创意方向；不需要在对话里输入“确认”。
                </p>
              </div>
            </div>
            <Button
              className="mt-3 w-full"
              disabled={isRunning}
              onClick={() => void confirmBriefAndGenerateDirections()}
            >
              {workflowBusy === "brief" ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}
              {workflowState?.creative ? "重新生成 3 个创意方向" : "确认 Brief 并生成 3 个方向"}
            </Button>
          </section>
        ) : null}
        {showDirectionSelection ? (
          <section className="mb-3 max-h-[48vh] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--canvas)] p-3">
            <div className="flex items-start gap-2.5">
              <Sparkles className="mt-0.5 size-4 shrink-0 text-[var(--accent)]" />
              <div>
                <h3 className="text-sm font-medium">选择一个创意方向</h3>
                <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
                  单选一个方向，可在下方补充或融合想法；提交后直接生成脚本。
                </p>
              </div>
            </div>
            <div role="radiogroup" aria-label="三个创意方向" className="mt-3 grid gap-2">
              {creativeDirections.map((direction, index) => {
                const selected = selectedDirectionIndex === index;
                return (
                  <button
                    key={`${workflowState?.creative?.nodeId ?? "creative"}-${index}`}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={isRunning}
                    onClick={() => setSelectedDirectionIndex(index)}
                    className={`flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors ${
                      selected
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--border)] hover:bg-[var(--surface-strong)]"
                    }`}
                  >
                    {selected ? (
                      <Check className="mt-0.5 size-4 shrink-0 text-[var(--accent)]" />
                    ) : (
                      <Circle className="mt-0.5 size-4 shrink-0 text-[var(--muted)]" />
                    )}
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{index + 1}. {direction.title}</span>
                      <span className="mt-1 block text-xs leading-5 text-[var(--muted)]">{direction.oneLine}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <label className="mt-3 grid gap-1.5 text-xs text-[var(--muted)]">
              补充或融合想法（可选）
              <textarea
                value={directionSupplement}
                disabled={isRunning}
                onChange={(event) => setDirectionSupplement(event.target.value)}
                rows={2}
                placeholder="例如：保留方向 1 的开场，融合方向 2 的水袖动作"
                className="nodrag resize-y rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm leading-5 text-[var(--text)] outline-none focus:border-[var(--focus)]"
              />
            </label>
            <Button
              className="mt-3 w-full"
              disabled={selectedDirectionIndex === null || isRunning}
              onClick={() => void generateScriptFromSelection()}
            >
              {workflowBusy === "script" ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              使用此方向直接生成脚本
            </Button>
          </section>
        ) : null}
        {selectedScripts.length > 1 ? (
          <p className="mb-3 rounded-lg border border-[var(--danger)]/40 bg-[var(--canvas)] px-3 py-2 text-xs leading-5 text-[var(--danger)]">
            请选择至多一个脚本节点。选中一个脚本时，它会作为生图或完整视频的当前版本。
          </p>
        ) : null}
        {activeScript ? (
          <section className="mb-3 rounded-xl border border-[var(--border)] bg-[var(--canvas)] p-3">
            <div className="flex items-start gap-2.5">
              <Check className="mt-0.5 size-4 shrink-0 text-[var(--accent)]" />
              <div>
                <h3 className="text-sm font-medium">{activeScript.title}</h3>
                <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
                  按当前脚本快照逐镜生成独立静态图；第三列英文 Prompt 会原样传给图片模型。
                </p>
              </div>
            </div>
            <Button
              className="mt-3 w-full"
              disabled={isRunning || selectedScripts.length > 1}
              onClick={() => void generateStoryboardImages()}
            >
              {workflowBusy === "storyboard-images" ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              脚本确认 开始生成
            </Button>
          </section>
        ) : null}
        {selectedFrames.length > 0 ? (
          <section className="mb-3 rounded-xl border border-[var(--border)] bg-[var(--canvas)] p-3">
            <div className="flex items-start gap-2.5">
              <Film className="mt-0.5 size-4 shrink-0 text-[var(--accent)]" />
              <div>
                <h3 className="text-sm font-medium">组合完整视频</h3>
                <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
                  已选择 {selectedFrames.length} 张图。必须覆盖当前脚本全部镜头，且每个镜头恰好一张；系统会读取实际图片、Audio/SFX 与 VO。
                </p>
              </div>
            </div>
            <Button
              className="mt-3 w-full"
              disabled={isRunning || !activeScript || selectedScripts.length > 1}
              onClick={() => void generateFullVideoPrompt()}
            >
              {workflowBusy === "video-prompt" ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              生成完整视频 Prompt
            </Button>
          </section>
        ) : null}
        {videoPromptResult ? (
          <section className="mb-3 rounded-xl border border-[var(--accent)]/50 bg-[var(--canvas)] p-3">
            <label className="grid gap-1.5 text-xs text-[var(--muted)]">
              完整视频 Prompt（确认前可编辑）
              <textarea
                value={videoPromptDraft}
                disabled={workflowBusy === "video-submit"}
                onChange={(event) => setVideoPromptDraft(event.target.value)}
                rows={8}
                className="resize-y rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs leading-5 text-[var(--text)] outline-none focus:border-[var(--focus)]"
              />
            </label>
            <p className="mt-2 text-[11px] leading-5 text-[var(--muted)]">
              总时长 {videoPromptResult.duration}s · {videoPromptResult.shotCount} 个镜头 · 原生声音开启 · VO 要求尽量逐字生成
            </p>
            <Button
              className="mt-3 w-full"
              disabled={isRunning || !videoPromptDraft.trim() || videoJob?.state === "queued" || videoJob?.state === "generating"}
              onClick={() => void submitFullVideo()}
            >
              {workflowBusy === "video-submit" ? <LoaderCircle className="size-4 animate-spin" /> : <Film className="size-4" />}
              确认并生成视频
            </Button>
            {videoJob ? (
              <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2.5 text-xs leading-5 text-[var(--muted)]">
                <p>视频任务：{videoJob.state}{videoJob.progress === null ? "" : ` · ${Math.round(videoJob.progress * 100)}%`}</p>
                {videoJob.error?.message ? <p className="text-[var(--danger)]">{videoJob.error.message}</p> : null}
                {videoJob.outputUrls[0] ? (
                  <video className="mt-2 w-full rounded-lg" src={videoJob.outputUrls[0]} controls />
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}
        {workflowError ? <p className="mb-2 text-xs leading-5 text-[var(--danger)]">{workflowError}</p> : null}
        {selectedNodes.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {selectedNodes.map((node) => (
              <span key={node.id} className="rounded-md bg-[var(--accent-soft)] px-2 py-1 text-[11px] text-[var(--accent)]">
                @{node.title}
              </span>
            ))}
          </div>
        ) : null}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--canvas)] p-2 focus-within:border-[var(--focus)]">
          <EditorContent editor={editor} />
          <div className="mt-1 flex items-center justify-between">
            <span className="px-1 text-[10px] text-[var(--muted)]">Enter 发送 · Shift Enter 换行</span>
            <Button size="icon" disabled={isRunning} aria-label="发送" onClick={() => void submit()}>
              {isRunning ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
            </Button>
          </div>
        </div>
      </footer>
    </motion.aside>
  );
}
