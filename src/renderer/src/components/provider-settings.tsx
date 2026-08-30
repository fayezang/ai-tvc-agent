import { useEffect, useState } from "react";
import { Bot, CreditCard, ImageIcon, KeyRound, Settings2, Video } from "lucide-react";
import type { ProviderStatus, ProviderValidation, ProviderVideoRouting } from "@shared/contracts";
import {
  DEFAULT_PROVIDER_MODELS,
  IMAGE_MODEL_OPTIONS,
  TEXT_MODEL_OPTIONS,
  VIDEO_MODEL_OPTIONS,
  type OrzModelOption
} from "@shared/orz-models";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "./ui/dialog";

interface ModelSelectProps {
  label: string;
  value: string;
  options: readonly OrzModelOption[];
  onChange(value: string): void;
}

const ModelSelect = ({ label, value, options, onChange }: ModelSelectProps): React.JSX.Element => (
  <label className="grid gap-1.5 text-sm">
    <span className="text-[var(--muted)]">{label}</span>
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-11 rounded-lg border border-[var(--border)] bg-[var(--canvas)] px-3 text-[var(--text)] outline-none focus:border-[var(--focus)]"
    >
      {options.map((model) => (
        <option key={model.id} value={model.id}>
          {model.name} · {model.description}
        </option>
      ))}
    </select>
  </label>
);

const videoRoles: readonly [keyof ProviderVideoRouting, string, string][] = [
  ["hook", "Hook", "开场抓注意力"],
  ["reveal", "Reveal", "产品展示与揭示"],
  ["proof", "Proof", "人物、证言与真实感"],
  ["cta", "CTA", "收束、品牌与行动号召"]
];

export function ProviderSettings(): React.JSX.Element {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [textModelId, setTextModelId] = useState<string>(DEFAULT_PROVIDER_MODELS.textModelId);
  const [imageModelId, setImageModelId] = useState<string>(DEFAULT_PROVIDER_MODELS.imageModelId);
  const [videoModelRouting, setVideoModelRouting] = useState<ProviderVideoRouting>({
    ...DEFAULT_PROVIDER_MODELS.videoModelRouting
  });
  const [message, setMessage] = useState("");
  const [validation, setValidation] = useState<ProviderValidation | null>(null);
  const [imageValidation, setImageValidation] = useState<ProviderValidation | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<"text" | "image" | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saved" | "error">("idle");

  useEffect(() => {
    void window.agentApp.provider.status().then((next) => {
      setStatus(next);
      setTextModelId(next.textModelId ?? DEFAULT_PROVIDER_MODELS.textModelId);
      setImageModelId(next.imageModelId ?? DEFAULT_PROVIDER_MODELS.imageModelId);
      setVideoModelRouting(next.videoModelRouting ?? { ...DEFAULT_PROVIDER_MODELS.videoModelRouting });
    });
  }, []);

  const markChanged = (): void => {
    setValidation(null);
    setImageValidation(null);
    setMessage("");
    setSaveState("idle");
  };

  const applyLowCostDefaults = (): void => {
    setTextModelId(DEFAULT_PROVIDER_MODELS.textModelId);
    setImageModelId(DEFAULT_PROVIDER_MODELS.imageModelId);
    setVideoModelRouting({ ...DEFAULT_PROVIDER_MODELS.videoModelRouting });
    setValidation(null);
    setImageValidation(null);
    setSaveState("idle");
    setMessage("已应用低成本测试配置，请点击“保存设置”。");
  };

  const save = async (): Promise<void> => {
    setMessage("");
    setSaving(true);
    try {
      const next = await window.agentApp.provider.configure({
        apiKey,
        textModelId,
        imageModelId,
        videoModelRouting
      });
      setStatus(next);
      setApiKey("");
      setValidation(null);
      setImageValidation(null);
      setSaveState("saved");
      setMessage("设置已保存。下次启动会直接使用，切换模型也无需重新填写 API Key。");
    } catch (error) {
      setSaveState("error");
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const runValidation = async (target: "text" | "image"): Promise<void> => {
    setTesting(target);
    setMessage("");
    setSaveState("idle");
    try {
      const check = target === "text"
        ? await window.agentApp.provider.validate()
        : await window.agentApp.provider.validateImage();
      if (target === "text") setValidation(check);
      else setImageValidation(check);
      setMessage(check.message);
    } catch (error) {
      const failure = {
        ok: false,
        httpStatus: null,
        message: error instanceof Error ? error.message : "验证失败"
      } satisfies ProviderValidation;
      if (target === "text") setValidation(failure);
      else setImageValidation(failure);
      setMessage(failure.message);
    } finally {
      setTesting(null);
    }
  };

  const latestValidation = imageValidation ?? validation;
  const connectionLabel = !status?.hasApiKey
    ? "未设置"
    : validation?.ok && imageValidation?.ok
      ? "文本+图片已连接"
      : validation?.ok
        ? "文本已连接"
        : imageValidation?.ok
          ? "图片已连接"
          : latestValidation
            ? "验证失败"
            : "已保存";

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Settings2 className="size-4" />
          模型与 API · {connectionLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[88vh] w-[min(94vw,760px)] overflow-hidden">
        <DialogTitle>模型与 API</DialogTitle>
        <DialogDescription>
          类似 CutAgent 的统一模型设置：只配置一次 ORZ Key，再为文本、图片和不同镜头角色选择默认模型。
        </DialogDescription>

        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--canvas)]/45 px-3 py-2">
          <p className="text-xs leading-5 text-[var(--muted)]">先跑通测试：Flash Lite + GPT-Image Low + Seedance 2</p>
          <Button variant="outline" size="sm" onClick={applyLowCostDefaults}>
            应用低成本测试配置
          </Button>
        </div>

        <div className="mt-4 grid max-h-[calc(88vh-260px)] gap-4 overflow-y-auto pr-1">
          <section className="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--canvas)]/45 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <KeyRound className="size-4 text-[var(--focus)]" />
              ORZ 统一连接
            </div>
            <label className="grid gap-2 text-sm">
              <span className="flex items-center justify-between gap-3 text-[var(--muted)]">
                API Key
                {status?.hasApiKey ? <span className="text-xs text-[var(--focus)]">已加密保存，无需重填</span> : null}
              </span>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  markChanged();
                }}
                autoComplete="off"
                className="h-11 rounded-lg border border-[var(--border)] bg-[var(--canvas)] px-3 outline-none focus:border-[var(--focus)]"
                placeholder={status?.hasApiKey ? "留空继续使用已保存的 Key" : "粘贴 ORZ API Key"}
              />
            </label>
            <p className="text-xs leading-5 text-[var(--muted)]">
              Key 只保存在 Electron 主进程的系统加密存储中，不进入 Renderer、项目文件或 SQLite。
            </p>
          </section>

          <section className="grid gap-3 rounded-xl border border-[var(--border)] p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Bot className="size-4 text-[var(--focus)]" />
              文本 Agent
            </div>
            <ModelSelect
              label="Brief、创意、脚本使用的文本模型"
              value={textModelId}
              options={TEXT_MODEL_OPTIONS}
              onChange={(value) => {
                setTextModelId(value);
                markChanged();
              }}
            />
          </section>

          <section className="grid gap-3 rounded-xl border border-[var(--border)] p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ImageIcon className="size-4 text-[var(--focus)]" />
              静态分镜图片
            </div>
            <ModelSelect
              label="每个镜头的分镜图与参考帧"
              value={imageModelId}
              options={IMAGE_MODEL_OPTIONS}
              onChange={(value) => {
                setImageModelId(value);
                markChanged();
              }}
            />
            <p className="text-xs leading-5 text-[var(--muted)]">
              文本连接正常不代表图片链路正常。切换图片模型后，建议单独点“测试图片模型”实际提交一次，验证会按该模型单价产生一张图的费用。
            </p>
          </section>

          <section className="grid gap-3 rounded-xl border border-[var(--border)] p-4">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium">
                <Video className="size-4 text-[var(--focus)]" />
                视频模型路由
              </div>
              <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
                生成时按镜头角色自动使用这里保存的模型，不在项目流程里重复询问。
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {videoRoles.map(([role, label, description]) => (
                <ModelSelect
                  key={role}
                  label={`${label} · ${description}`}
                  value={videoModelRouting[role]}
                  options={VIDEO_MODEL_OPTIONS}
                  onChange={(value) => {
                    setVideoModelRouting((current) => ({ ...current, [role]: value }));
                    markChanged();
                  }}
                />
              ))}
            </div>
          </section>

        </div>
        <div
          role="status"
          aria-live="polite"
          className={`mt-3 min-h-5 text-xs leading-5 ${
            saveState === "error" || (latestValidation && !latestValidation.ok)
              ? "text-[var(--danger)]"
              : saveState === "saved" || latestValidation?.ok
                ? "text-[var(--focus)]"
                : "text-[var(--muted)]"
          }`}
        >
          {message || "修改模型后点击保存；已保存的 API Key 不需要重新填写。"}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
          <Button variant="outline" onClick={() => void window.agentApp.provider.openTopUp()}>
            <CreditCard className="size-4" />
            打开 ORZ 充值
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={Boolean(testing) || !status?.hasApiKey}
              onClick={() => void runValidation("text")}
            >
              {testing === "text" ? "测试中…" : "测试文本连接"}
            </Button>
            <Button
              variant="outline"
              disabled={Boolean(testing) || !status?.hasApiKey}
              onClick={() => void runValidation("image")}
            >
              {testing === "image" ? "测试中…" : "测试图片模型"}
            </Button>
            <Button
              disabled={saving || (!status?.hasApiKey && !apiKey.trim())}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : saveState === "saved" ? "已保存 ✓" : "保存设置"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
