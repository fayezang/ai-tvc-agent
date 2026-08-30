import type { NodeKind } from "@shared/contracts";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

const nodeOptions: ReadonlyArray<{ kind: NodeKind; title: string; description: string }> = [
  { kind: "brief", title: "Brief", description: "产品、受众、素材与限制" },
  { kind: "creative-direction", title: "创意方向", description: "恰好三个可选择方向" },
  { kind: "script", title: "结构化脚本", description: "镜头、画面、旁白与时长" },
  { kind: "storyboard", title: "静态分镜", description: "逐镜头独立生成与确认" },
  { kind: "video", title: "视频版本", description: "模型匹配、生成与版本对比" },
  { kind: "audio", title: "旁白与音乐", description: "基础旁白和配乐" },
  { kind: "export", title: "导出", description: "基础 MP4 输出" }
];

interface NodeCreatorProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreate(kind: NodeKind): void;
}

export function NodeCreator({ open, onOpenChange, onCreate }: NodeCreatorProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>创建工作节点</DialogTitle>
        <DialogDescription>只提供当前 TVC 核心流程需要的节点类型。</DialogDescription>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {nodeOptions.map((option) => (
            <button
              type="button"
              key={option.kind}
              onClick={() => onCreate(option.kind)}
              className="rounded-xl border border-[var(--border)] bg-[var(--canvas)] p-3 text-left transition-colors duration-150 hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
            >
              <span className="block text-sm font-medium">{option.title}</span>
              <span className="mt-1 block text-xs leading-5 text-[var(--muted)]">{option.description}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
