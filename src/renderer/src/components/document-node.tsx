import { useEffect, useRef, useState } from "react";
import { Markdown } from "@tiptap/markdown";
import Image from "@tiptap/extension-image";
import { EditorContent, useEditor } from "@tiptap/react";
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { Handle, NodeResizeControl, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import { Check, CircleAlert, GripHorizontal, LoaderCircle } from "lucide-react";
import type { CanvasNode } from "@shared/contracts";
import { cn } from "../lib/utils";

export interface DocumentNodeData extends Record<string, unknown> {
  meta: CanvasNode;
  canvasNodes: readonly CanvasNode[];
  projectRoot: string;
  onProjectChanged(): Promise<void> | void;
}

export type DocumentFlowNode = Node<DocumentNodeData, "document">;

const statusLabel: Readonly<Record<CanvasNode["status"], string>> = {
  draft: "草稿",
  "awaiting-approval": "待确认",
  approved: "已确认",
  generating: "生成中",
  completed: "已完成",
  failed: "失败"
};

export function DocumentNode({ data, selected }: NodeProps<DocumentFlowNode>): React.JSX.Element {
  const { meta, projectRoot } = data;
  const [loadError, setLoadError] = useState("");
  const hydrated = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editor = useEditor({
    extensions: [
      StarterKit,
      TableKit.configure({ table: { resizable: true, lastColumnResizable: false } }),
      Image.configure({ inline: false, allowBase64: true }),
      Markdown
    ],
    content: "",
    contentType: "markdown",
    editorProps: {
      attributes: {
        class: "tiptap-node-editor nodrag nowheel",
        spellcheck: "true"
      }
    },
    onUpdate: ({ editor: currentEditor }) => {
      if (!hydrated.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void window.agentApp.project.writeBody({
          projectRoot,
          bodyPath: meta.bodyPath,
          markdown: currentEditor.getMarkdown()
        });
      }, 450);
    }
  });

  useEffect(() => {
    hydrated.current = false;
    setLoadError("");
    void window.agentApp.project
      .readBody({ projectRoot, bodyPath: meta.bodyPath })
      .then((markdown) => {
        editor?.commands.setContent(markdown, { contentType: "markdown" });
        hydrated.current = true;
      })
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "读取节点失败"));
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [editor, meta.bodyPath, meta.status, projectRoot]);

  return (
    <div className="relative size-full min-h-52">
      <Handle type="target" position={Position.Left} className="!size-2.5 !border-2 !border-[var(--surface)] !bg-[var(--accent)]" />
      <article
        className={cn(
          "flex size-full min-h-52 flex-col overflow-hidden rounded-2xl border bg-[var(--surface)] shadow-[0_18px_55px_rgba(0,0,0,.22)]",
          selected ? "border-[var(--accent)] ring-2 ring-[var(--accent-soft)]" : "border-[var(--border)]"
        )}
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{meta.title}</p>
            <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--muted)]">{meta.kind}</p>
          </div>
          <span className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
            {meta.status === "generating" ? <LoaderCircle className="size-3 animate-spin" /> : null}
            {meta.status === "completed" || meta.status === "approved" ? <Check className="size-3" /> : null}
            {meta.status === "failed" ? <CircleAlert className="size-3" /> : null}
            {statusLabel[meta.status]}
          </span>
        </header>
        <div className="nodrag nowheel min-h-0 flex-1 overflow-auto p-4">
          {loadError ? <p className="text-sm text-[var(--danger)]">{loadError}</p> : <EditorContent editor={editor} />}
        </div>
      </article>
      <NodeResizer
        minWidth={340}
        minHeight={220}
        maxHeight={1400}
        keepAspectRatio={false}
        autoScale={false}
        isVisible={selected}
        lineClassName="!z-40 !border-[var(--accent)]"
        handleClassName="!z-40 !size-3 !border-2 !border-[var(--surface)] !bg-[var(--accent)]"
      />
      {selected ? (
        <NodeResizeControl
          position="bottom-right"
          resizeDirection="vertical"
          minHeight={220}
          maxHeight={1400}
          autoScale={false}
          className="nodrag !bottom-0 !left-0 !right-0 !z-50 !flex !h-8 !w-full !translate-x-0 !translate-y-0 !cursor-ns-resize !items-center !justify-center !rounded-b-2xl !border-0 !border-t !border-[var(--accent)] !bg-[color-mix(in_srgb,var(--surface)_88%,transparent)] !text-[var(--accent)] !shadow-lg"
        >
          <span className="flex items-center gap-1.5 rounded-full bg-[var(--surface-strong)] px-3 py-1 text-[10px] font-medium">
            <GripHorizontal className="size-3.5" />
            上下拖动调整高度
          </span>
        </NodeResizeControl>
      ) : null}
      <Handle type="source" position={Position.Right} className="!size-2.5 !border-2 !border-[var(--surface)] !bg-[var(--accent)]" />
    </div>
  );
}
