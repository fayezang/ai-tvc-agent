import { useCallback, useState } from "react";
import { ArrowLeft, PanelRightOpen } from "lucide-react";
import type { CanvasSnapshot, ProjectState } from "@shared/contracts";
import { AgentPanel } from "./components/agent-panel";
import { CanvasWorkspace } from "./components/canvas-workspace";
import { ProviderSettings } from "./components/provider-settings";
import { StartScreen } from "./components/start-screen";
import { Button } from "./components/ui/button";
import { useUiStore } from "./store/ui-store";

export default function App(): React.JSX.Element {
  const [projectState, setProjectState] = useState<ProjectState | null>(null);
  const [canvas, setCanvas] = useState<CanvasSnapshot | null>(null);
  const [canvasRevision, setCanvasRevision] = useState(0);
  const [initialAgentNotice, setInitialAgentNotice] = useState<string | undefined>();
  const panelOpen = useUiStore((state) => state.agentPanelOpen);
  const setPanelOpen = useUiStore((state) => state.setAgentPanelOpen);
  const reloadProject = useCallback(async (): Promise<void> => {
    if (!projectState) return;
    const next = await window.agentApp.project.reload(projectState.project.rootPath);
    setProjectState(next);
    setCanvas(next.canvas);
    setCanvasRevision((current) => current + 1);
  }, [projectState]);

  if (!projectState || !canvas) {
    return (
      <StartScreen
        onOpen={(next, notice) => {
          setProjectState(next);
          setCanvas(next.canvas);
          setCanvasRevision(0);
          setInitialAgentNotice(notice);
        }}
      />
    );
  }

  return (
    <main className="grid h-screen grid-rows-[56px_1fr] overflow-hidden bg-[var(--canvas)]">
      <header className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label="返回项目首页"
            onClick={() => {
              setProjectState(null);
              setCanvas(null);
              setCanvasRevision(0);
              setInitialAgentNotice(undefined);
            }}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">{projectState.project.name}</h1>
            <p className="text-[10px] text-[var(--muted)]">
              {projectState.project.aspectRatio ?? "16:9"} · {projectState.project.adDuration} 秒 · 本地项目
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <ProviderSettings />
          {!panelOpen ? (
            <Button variant="ghost" size="sm" onClick={() => setPanelOpen(true)}>
              <PanelRightOpen className="size-4" />
              Agent
            </Button>
          ) : null}
        </div>
      </header>
      <div className="flex min-h-0">
        <section className="min-w-0 flex-1">
          <CanvasWorkspace
            key={`${projectState.project.rootPath}:${canvasRevision}`}
            project={projectState.project}
            initialCanvas={canvas}
            onCanvasChange={setCanvas}
            onProjectChanged={reloadProject}
          />
        </section>
        {panelOpen ? (
          <AgentPanel
            projectRoot={projectState.project.rootPath}
            canvasNodes={canvas.nodes}
            onProjectChanged={reloadProject}
            initialNotice={initialAgentNotice}
          />
        ) : null}
      </div>
    </main>
  );
}
