import { useEffect, useState } from "react";
import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import { Check, CircleAlert, FilePlus2, ImageIcon, LoaderCircle, RefreshCw } from "lucide-react";
import type { CanvasNode, StoryboardImageState } from "@shared/contracts";
import { cn } from "../lib/utils";
import { useUiStore } from "../store/ui-store";
import type { DocumentNodeData } from "./document-node";
import { Button } from "./ui/button";

export type StoryboardImageFlowNode = Node<DocumentNodeData, "storyboardImage">;

const statusLabel: Readonly<Record<CanvasNode["status"], string>> = {
  draft: "草稿",
  "awaiting-approval": "待确认",
  approved: "已确认",
  generating: "生成中",
  completed: "已完成",
  failed: "失败"
};

export function StoryboardImageNode({ data, selected }: NodeProps<StoryboardImageFlowNode>): React.JSX.Element {
  const { meta, projectRoot, canvasNodes, onProjectChanged } = data;
  const selectedNodeIds = useUiStore((state) => state.selectedNodeIds);
  const [imageState, setImageState] = useState<StoryboardImageState | null>(null);
  const [prompt, setPrompt] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState<"regenerate" | "apply" | "select" | null>(null);
  const [message, setMessage] = useState("");

  const selectedVersion = imageState?.versions.find((version) => version.id === imageState.selectedVersionId) ??
    imageState?.versions.at(-1);

  const loadState = async (): Promise<void> => {
    const next = await window.agentApp.agent.storyboardImageState({ projectRoot, nodeId: meta.id });
    setImageState(next);
    const current = next.versions.find((version) => version.id === next.selectedVersionId) ?? next.versions.at(-1);
    setPrompt(current?.prompt ?? "");
  };

  useEffect(() => {
    setLoadError("");
    void loadState()
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "读取图片失败"));
  }, [meta.id, meta.status, projectRoot]);

  const regenerate = async (): Promise<void> => {
    if (!prompt.trim() || busy) return;
    setBusy("regenerate");
    setMessage("");
    try {
      const next = await window.agentApp.agent.regenerateStoryboardImage({
        projectRoot,
        nodeId: meta.id,
        prompt: prompt.trim()
      });
      setImageState(next);
      const latest = next.versions.at(-1);
      setMessage(latest?.status === "failed" ? `生成失败：${latest.error ?? "未知错误"}` : "新图片版本已生成，旧版本仍然保留。");
      await onProjectChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "重新生成失败");
    } finally {
      setBusy(null);
    }
  };

  const selectVersion = async (versionId: string): Promise<void> => {
    if (busy) return;
    setBusy("select");
    try {
      const next = await window.agentApp.agent.selectStoryboardImageVersion({ projectRoot, nodeId: meta.id, versionId });
      setImageState(next);
      setPrompt(next.versions.find((version) => version.id === versionId)?.prompt ?? "");
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "切换图片版本失败");
    } finally {
      setBusy(null);
    }
  };

  const applyToScript = async (): Promise<void> => {
    if (busy || !imageState?.selectedVersionId) return;
    const selectedScripts = canvasNodes.filter(
      (node) => node.kind === "script" && selectedNodeIds.includes(node.id)
    );
    if (selectedScripts.length > 1) {
      setMessage("只能选择一个脚本节点作为新版本基础。");
      return;
    }
    setBusy("apply");
    setMessage("");
    try {
      const reply = await window.agentApp.agent.applyStoryboardImage({
        projectRoot,
        nodeId: meta.id,
        ...(selectedScripts[0] ? { baseScriptNodeId: selectedScripts[0].id } : {})
      });
      setMessage(reply.text);
      await onProjectChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "应用失败");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="relative size-full min-h-60">
      <Handle type="target" position={Position.Left} className="!size-2.5 !border-2 !border-[var(--surface)] !bg-[var(--accent)]" />
      <article
        className={cn(
          "flex size-full min-h-60 flex-col overflow-hidden rounded-2xl border bg-[var(--surface)] shadow-[0_20px_60px_rgba(0,0,0,.3)]",
          selected ? "border-[var(--accent)] ring-2 ring-[var(--accent-soft)]" : "border-[var(--border)]"
        )}
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
          <div className="flex min-w-0 items-center gap-2">
            <ImageIcon className="size-4 shrink-0 text-[var(--accent)]" />
            <p className="truncate text-sm font-semibold">{meta.title}</p>
          </div>
          <span className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
            {meta.status === "generating" ? <LoaderCircle className="size-3 animate-spin" /> : null}
            {meta.status === "completed" || meta.status === "approved" ? <Check className="size-3" /> : null}
            {meta.status === "failed" ? <CircleAlert className="size-3" /> : null}
            {statusLabel[meta.status]}
          </span>
        </header>
        <div className="nodrag nowheel min-h-0 flex-1 overflow-y-auto bg-black/35 p-2">
          {loadError ? (
            <div className="grid size-full place-items-center px-5 text-center text-sm text-[var(--danger)]">{loadError}</div>
          ) : selectedVersion?.dataUrl ? (
            <img src={selectedVersion.dataUrl} alt={meta.title} className="max-h-[340px] w-full rounded-xl object-contain" draggable={false} />
          ) : selectedVersion?.status === "failed" ? (
            <div className="grid min-h-48 place-items-center px-5 text-center text-sm text-[var(--danger)]">
              {selectedVersion.error ?? "图片生成失败，请修改 Prompt 后手动重新生成。"}
            </div>
          ) : (
            <div className="grid min-h-48 place-items-center text-sm text-[var(--muted)]">正在生成静态图…</div>
          )}
          {selected && imageState ? (
            <section className="mt-2 grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
              <label className="grid gap-1.5 text-[11px] text-[var(--muted)]">
                当前图片 Prompt
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={4}
                  className="nodrag nowheel resize-y rounded-lg border border-[var(--border)] bg-[var(--canvas)] px-3 py-2 text-xs leading-5 text-[var(--text)] outline-none focus:border-[var(--focus)]"
                />
              </label>
              <div className="flex gap-2">
                <Button className="flex-1" size="sm" disabled={Boolean(busy) || !prompt.trim()} onClick={() => void regenerate()}>
                  {busy === "regenerate" ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                  使用此 Prompt 重新生成
                </Button>
                <Button variant="outline" className="flex-1" size="sm" disabled={Boolean(busy) || !imageState.selectedVersionId} onClick={() => void applyToScript()}>
                  {busy === "apply" ? <LoaderCircle className="size-3.5 animate-spin" /> : <FilePlus2 className="size-3.5" />}
                  应用到新脚本版本
                </Button>
              </div>
              {imageState.versions.length > 1 ? (
                <div className="flex gap-2 overflow-x-auto pt-1">
                  {imageState.versions.map((version, index) => (
                    <button
                      key={version.id}
                      type="button"
                      disabled={Boolean(busy) || version.status !== "ready"}
                      title={version.prompt}
                      onClick={() => void selectVersion(version.id)}
                      className={cn(
                        "h-14 w-20 shrink-0 overflow-hidden rounded-lg border text-[10px]",
                        version.id === imageState.selectedVersionId ? "border-[var(--accent)]" : "border-[var(--border)]",
                        version.status !== "ready" && "text-[var(--danger)]"
                      )}
                    >
                      {version.dataUrl ? <img src={version.dataUrl} alt={`版本 ${index + 1}`} className="size-full object-cover" /> : `失败 V${index + 1}`}
                    </button>
                  ))}
                </div>
              ) : null}
              {message ? <p className={cn("text-[11px] leading-5", message.includes("失败") ? "text-[var(--danger)]" : "text-[var(--muted)]")}>{message}</p> : null}
            </section>
          ) : null}
        </div>
      </article>
      <NodeResizer
        minWidth={320}
        minHeight={240}
        maxWidth={1800}
        maxHeight={1600}
        keepAspectRatio={false}
        autoScale={false}
        isVisible={selected}
        lineClassName="!z-40 !border-[var(--accent)]"
        handleClassName="!z-40 !size-3 !border-2 !border-[var(--surface)] !bg-[var(--accent)]"
      />
      <Handle type="source" position={Position.Right} className="!size-2.5 !border-2 !border-[var(--surface)] !bg-[var(--accent)]" />
    </div>
  );
}
