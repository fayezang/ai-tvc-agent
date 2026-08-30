import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type OnSelectionChangeParams,
  type Viewport
} from "@xyflow/react";
import { Focus, Minus, Plus } from "lucide-react";
import type { CanvasSnapshot, NodeKind, ProjectSummary } from "@shared/contracts";
import { useUiStore } from "../store/ui-store";
import { DocumentNode, type DocumentFlowNode } from "./document-node";
import { StoryboardImageNode, type StoryboardImageFlowNode } from "./storyboard-image-node";
import { NodeCreator } from "./node-creator";
import { Button } from "./ui/button";

interface CanvasWorkspaceProps {
  project: ProjectSummary;
  initialCanvas: CanvasSnapshot;
  onCanvasChange(canvas: CanvasSnapshot): void;
  onProjectChanged(): Promise<void> | void;
}

type CanvasFlowNode = DocumentFlowNode | StoryboardImageFlowNode;

const nodeTypes = { document: DocumentNode, storyboardImage: StoryboardImageNode };

const toFlowNodes = (
  canvas: CanvasSnapshot,
  projectRoot: string,
  onProjectChanged: () => Promise<void> | void
): CanvasFlowNode[] =>
  canvas.nodes.map((node) => ({
    id: node.id,
    type: node.kind === "storyboard-overview" || node.kind === "storyboard-frame" ? "storyboardImage" : "document",
    position: node.position,
    data: { meta: node, canvasNodes: canvas.nodes, projectRoot, onProjectChanged },
    style: { width: node.width ?? 440, height: node.height ?? 300 }
  }));

function CanvasControls(): React.JSX.Element {
  const { zoomIn, zoomOut, fitView, getZoom } = useReactFlow();
  const [zoom, setZoom] = useState(() => Math.round(getZoom() * 100));

  useEffect(() => {
    const timer = setInterval(() => setZoom(Math.round(getZoom() * 100)), 250);
    return () => clearInterval(timer);
  }, [getZoom]);

  return (
    <Panel position="bottom-left" className="!m-4 flex items-center rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 shadow-xl">
      <Button variant="ghost" size="icon" aria-label="缩小" onClick={() => void zoomOut({ duration: 180 })}>
        <Minus className="size-4" />
      </Button>
      <span className="w-12 text-center font-mono text-xs text-[var(--muted)]">{zoom}%</span>
      <Button variant="ghost" size="icon" aria-label="放大" onClick={() => void zoomIn({ duration: 180 })}>
        <Plus className="size-4" />
      </Button>
      <span className="mx-1 h-5 w-px bg-[var(--border)]" />
      <Button variant="ghost" size="icon" aria-label="适应画布" onClick={() => void fitView({ duration: 220, padding: 0.16 })}>
        <Focus className="size-4" />
      </Button>
    </Panel>
  );
}

function CanvasInner({ project, initialCanvas, onCanvasChange, onProjectChanged }: CanvasWorkspaceProps): React.JSX.Element {
  const [nodes, setNodes] = useState<CanvasFlowNode[]>(() =>
    toFlowNodes(initialCanvas, project.rootPath, onProjectChanged)
  );
  const [edges, setEdges] = useState<Edge[]>(() => initialCanvas.edges.map((edge) => ({ ...edge })));
  const [viewport, setViewport] = useState<Viewport>(initialCanvas.viewport);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [creationPoint, setCreationPoint] = useState({ x: 200, y: 160 });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { screenToFlowPosition } = useReactFlow();
  const setSelectedNodeIds = useUiStore((state) => state.setSelectedNodeIds);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    []
  );

  useEffect(() => {
    setNodes((current) => {
      const selectedIds = new Set(current.filter((node) => node.selected).map((node) => node.id));
      return toFlowNodes(initialCanvas, project.rootPath, onProjectChanged).map((node) => ({
        ...node,
        selected: selectedIds.has(node.id)
      }));
    });
    setEdges(initialCanvas.edges.map((edge) => ({ ...edge })));
  }, [initialCanvas, onProjectChanged, project.rootPath]);

  const snapshot = useCallback(
    (nextNodes = nodes, nextEdges = edges, nextViewport = viewport): CanvasSnapshot => ({
      version: 1,
      nodes: nextNodes.map((node) => ({
        ...node.data.meta,
        position: node.position,
        width: typeof node.width === "number" ? node.width : Number(node.style?.width ?? node.data.meta.width ?? 440),
        height: typeof node.height === "number" ? node.height : Number(node.style?.height ?? node.data.meta.height ?? 300)
      })),
      edges: nextEdges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
      viewport: nextViewport
    }),
    [edges, nodes, viewport]
  );

  const persist = useCallback(
    (nextNodes = nodes, nextEdges = edges, nextViewport = viewport) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const next = snapshot(nextNodes, nextEdges, nextViewport);
        onCanvasChange(next);
        void window.agentApp.project.saveCanvas({ projectRoot: project.rootPath, canvas: next });
      }, 260);
    },
    [edges, nodes, onCanvasChange, project.rootPath, snapshot, viewport]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCreationPoint(screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
        setCreatorOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [screenToFlowPosition]);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasFlowNode>[]) => {
      setNodes((current) => {
        const next = applyNodeChanges(changes, current);
        // Selection is UI-only state. Persisting it triggers a parent canvas refresh
        // that immediately clears React Flow's selected flag and hides resize handles.
        if (changes.some((change) => change.type !== "select")) {
          persist(next, edges, viewport);
        }
        return next;
      });
    },
    [edges, persist, viewport]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      setEdges((current) => {
        const next = applyEdgeChanges(changes, current);
        persist(nodes, next, viewport);
        return next;
      });
    },
    [nodes, persist, viewport]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) => {
        const next = addEdge(connection, current);
        persist(nodes, next, viewport);
        return next;
      });
    },
    [nodes, persist, viewport]
  );

  const onSelectionChange = useCallback(
    ({ nodes: selectedNodes }: OnSelectionChangeParams) => {
      setSelectedNodeIds(selectedNodes.map((node) => node.id));
    },
    [setSelectedNodeIds]
  );

  const createNode = async (kind: NodeKind): Promise<void> => {
    const created = await window.agentApp.project.createNode({
      projectRoot: project.rootPath,
      kind,
      position: creationPoint
    });
    setNodes((current) => [
      ...current,
      ...toFlowNodes({ version: 1, nodes: [created], edges: [], viewport }, project.rootPath, onProjectChanged)
    ]);
    setCreatorOpen(false);
  };

  const contextItems = useMemo(
    () => [
      ["creative-direction", "创意方向"],
      ["script", "结构化脚本"],
      ["storyboard", "静态分镜"],
      ["video", "视频版本"]
    ] as const,
    []
  );

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div className="size-full">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectionChange={onSelectionChange}
            onPaneClick={(event) => {
              if (event.detail === 2) {
                setCreationPoint(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
                setCreatorOpen(true);
              }
            }}
            onPaneContextMenu={(event) => {
              setCreationPoint(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
            }}
            onMoveEnd={(_event, nextViewport) => {
              setViewport(nextViewport);
              persist(nodes, edges, nextViewport);
            }}
            defaultViewport={initialCanvas.viewport}
            panOnScroll
            selectionOnDrag
            panOnDrag={[1, 2]}
            zoomOnDoubleClick={false}
            selectionMode={SelectionMode.Partial}
            panActivationKeyCode="Space"
            minZoom={0.12}
            maxZoom={2.5}
            deleteKeyCode={["Backspace", "Delete"]}
            colorMode="dark"
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--canvas-dot)" />
            <CanvasControls />
          </ReactFlow>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-48 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-2xl">
          <ContextMenu.Label className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--muted)]">
            创建节点
          </ContextMenu.Label>
          {contextItems.map(([kind, label]) => (
            <ContextMenu.Item
              key={kind}
              onSelect={() => void createNode(kind)}
              className="cursor-default rounded-lg px-2 py-2 text-sm outline-none hover:bg-[var(--surface-strong)] focus:bg-[var(--surface-strong)]"
            >
              {label}
            </ContextMenu.Item>
          ))}
          <ContextMenu.Separator className="my-1 h-px bg-[var(--border)]" />
          <ContextMenu.Item
            onSelect={() => setCreatorOpen(true)}
            className="cursor-default rounded-lg px-2 py-2 text-sm text-[var(--muted)] outline-none hover:bg-[var(--surface-strong)] focus:bg-[var(--surface-strong)]"
          >
            更多节点… <span className="float-right font-mono text-xs">⌘K</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
      <NodeCreator open={creatorOpen} onOpenChange={setCreatorOpen} onCreate={(kind) => void createNode(kind)} />
    </ContextMenu.Root>
  );
}

export function CanvasWorkspace(props: CanvasWorkspaceProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
