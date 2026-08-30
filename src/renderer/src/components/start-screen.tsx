import { useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import Image from "@tiptap/extension-image";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { ArrowUp, Clock3, FolderOpen, ImagePlus, LoaderCircle, RectangleHorizontal } from "lucide-react";
import type { AdDuration, AspectRatio, ProjectState } from "@shared/contracts";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { ProviderSettings } from "./provider-settings";

interface StartScreenProps {
  onOpen(project: ProjectState, initialAgentNotice?: string): void;
}

const durations = [5, 8, 10, 15] as const;
const aspectRatios = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;

const cleanError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "创建项目失败";
  return message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/i, "");
};

const imageBox = (ratio: AspectRatio): { width: number; height: number } => {
  const [width = 16, height = 9] = ratio.split(":").map(Number);
  const scale = 24 / Math.max(width, height);
  return { width: Math.max(8, width * scale), height: Math.max(8, height * scale) };
};

const fileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });

export function StartScreen({ onOpen }: StartScreenProps): React.JSX.Element {
  const [duration, setDuration] = useState<AdDuration | null>(null);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [referenceCount, setReferenceCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editor = useEditor({
    extensions: [StarterKit, Image.configure({ allowBase64: true }), Markdown],
    content: "",
    editorProps: {
      attributes: {
        class: "start-brief-editor",
        "aria-label": "描述创意想法、画面风格和 VO",
        "data-placeholder": "一句话描述创意想法、理想画面风格；有明确 VO 可直接写在这里…"
      }
    }
  });

  const addReferenceImages = async (files: FileList | null): Promise<void> => {
    if (!files || !editor) return;
    setError("");
    const remaining = 12 - referenceCount;
    const selected = Array.from(files).slice(0, remaining);
    if (files.length > remaining) setError("参考图最多 12 张，已添加允许范围内的图片。");
    let added = 0;
    for (const file of selected) {
      if (!file.type.match(/^image\/(png|jpe?g|webp)$/)) {
        setError("仅支持 PNG、JPEG 和 WebP 图片。");
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError("单张参考图不能超过 10MB。");
        continue;
      }
      const src = await fileAsDataUrl(file);
      editor.chain().focus().setImage({ src, alt: file.name, title: file.name }).run();
      added += 1;
    }
    setReferenceCount((current) => current + added);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const createProject = async (): Promise<void> => {
    if (duration === null) {
      setError("请先手动选择广告时长。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const plainText = editor?.getText().replace(/\s+/g, " ").trim() ?? "";
      const name = plainText.slice(0, 56) || `未命名创意-${new Date().toLocaleDateString("zh-CN").replaceAll("/", "-")}`;
      const project = await window.agentApp.project.create({
        name,
        adDuration: duration,
        aspectRatio,
        briefMarkdown: editor?.getMarkdown().trim() ?? ""
      });
      if (!project) return;

      let initialAgentNotice = "";
      try {
        const reply = await window.agentApp.agent.restateBrief({ projectRoot: project.project.rootPath });
        initialAgentNotice = reply.text;
      } catch (cause) {
        initialAgentNotice = `Brief 已保存在本地，但 AI 复述失败：${cleanError(cause)}`;
      }
      const refreshed = await window.agentApp.project.reload(project.project.rootPath);
      onOpen(refreshed, initialAgentNotice);
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setBusy(false);
    }
  };

  const openProject = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const project = await window.agentApp.project.open();
      if (project) onOpen(project);
    } catch (cause) {
      setError(cleanError(cause));
    } finally {
      setBusy(false);
    }
  };

  const selectedBox = imageBox(aspectRatio);

  return (
    <main className="grid min-h-screen grid-rows-[64px_1fr] bg-[var(--canvas)]">
      <header className="flex items-center justify-between border-b border-[var(--border)] px-6">
        <span className="font-semibold tracking-[-0.02em]">AI TVC Agent</span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void openProject()}>
            <FolderOpen className="size-4" />
            打开项目
          </Button>
          <ProviderSettings />
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-5xl flex-col justify-center px-8 pb-20">
        <div className="mb-8 text-center">
          <h1 className="text-4xl font-semibold tracking-[-0.045em]">一句话开始你的 TVC</h1>
          <p className="mx-auto mt-3 max-w-2xl text-base leading-7 text-[var(--muted)]">
            描述创意想法、理想画面风格；有明确 VO 可以直接写。也可以在文字中插入产品图、Logo 或角色参考图。
          </p>
        </div>

        <div className="rounded-[28px] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[0_24px_90px_rgba(0,0,0,.28)]">
          <EditorContent editor={editor} />

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                onChange={(event) => void addReferenceImages(event.target.files)}
              />
              <Button variant="outline" size="sm" disabled={referenceCount >= 12} onClick={() => fileInputRef.current?.click()}>
                <ImagePlus className="size-4" />
                参考图{referenceCount > 0 ? ` ${referenceCount}/12` : ""}
              </Button>

              <Popover.Root>
                <Popover.Trigger asChild>
                  <Button variant="outline" size="sm">
                    <span
                      className="rounded-[2px] border-2 border-current"
                      style={{ width: selectedBox.width, height: selectedBox.height }}
                    />
                    {aspectRatio}
                  </Button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    sideOffset={10}
                    align="start"
                    className="z-50 w-[430px] rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-2xl"
                  >
                    <p className="text-sm text-[var(--muted)]">选择画面比例</p>
                    <div className="mt-3 grid grid-cols-6 gap-1 rounded-xl bg-[var(--canvas)] p-1.5">
                      {aspectRatios.map((ratio) => {
                        const box = imageBox(ratio);
                        return (
                          <button
                            key={ratio}
                            type="button"
                            onClick={() => setAspectRatio(ratio)}
                            className={cn(
                              "flex h-20 flex-col items-center justify-center gap-2 rounded-lg text-xs",
                              aspectRatio === ratio ? "bg-[var(--surface-strong)] text-[var(--text)]" : "text-[var(--muted)]"
                            )}
                          >
                            <span className="rounded-[2px] border-2 border-current" style={{ width: box.width, height: box.height }} />
                            {ratio}
                          </button>
                        );
                      })}
                    </div>
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>

              <Popover.Root>
                <Popover.Trigger asChild>
                  <Button variant="outline" size="sm" className={duration === null ? "text-[var(--muted)]" : ""}>
                    <Clock3 className="size-4" />
                    {duration === null ? "选择时长" : `${duration}s`}
                  </Button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    sideOffset={10}
                    align="start"
                    className="z-50 w-[440px] rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl"
                  >
                    <p className="text-sm text-[var(--muted)]">选择视频生成时长（必选）</p>
                    <div className="relative mt-6 px-3">
                      <div className="absolute left-8 right-8 top-3 h-1 rounded-full bg-[var(--surface-strong)]" />
                      <div className="relative grid grid-cols-4 gap-2">
                        {durations.map((seconds) => (
                          <button
                            key={seconds}
                            type="button"
                            onClick={() => setDuration(seconds)}
                            className="flex flex-col items-center gap-2 text-xs text-[var(--muted)]"
                          >
                            <span
                              className={cn(
                                "z-10 size-6 rounded-full border-4 transition-colors",
                                duration === seconds
                                  ? "border-[var(--accent)] bg-[var(--accent)]"
                                  : "border-[var(--surface)] bg-[var(--border-strong)]"
                              )}
                            />
                            <span className={duration === seconds ? "text-[var(--text)]" : ""}>{seconds}s</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            </div>

            <Button
              size="icon"
              disabled={busy || duration === null}
              aria-label="创建项目并让 AI 复述 Brief"
              onClick={() => void createProject()}
            >
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
            </Button>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between px-2 text-xs text-[var(--muted)]">
          <span className="flex items-center gap-1.5">
            <RectangleHorizontal className="size-3.5" />
            画幅默认 16:9；只有时长必须手动选择，其余信息不做强制限制。
          </span>
          {busy ? <span>正在创建本地项目并由文本 AI 复述 Brief…</span> : null}
        </div>
        {error ? <p className="mt-4 text-center text-sm text-[var(--danger)]">{error}</p> : null}
      </section>
    </main>
  );
}
