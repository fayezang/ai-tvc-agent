import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { utilityProcess, type UtilityProcess } from "electron";
import type { AgentUiEvent, ProviderVideoRouting } from "../shared/contracts.js";

interface UtilityResponse {
  id?: string;
  result?: unknown;
  error?: string;
  type?: "event";
  event?: AgentUiEvent;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class UtilityClient {
  private child: UtilityProcess | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private readonly eventListeners = new Set<(event: AgentUiEvent) => void>();

  start(): void {
    if (this.child) return;
    this.child = utilityProcess.fork(join(__dirname, "utility.js"), [], {
      serviceName: "AI TVC Agent Utility"
    });
    this.child.on("message", (message: UtilityResponse) => {
      if (message.type === "event" && message.event) {
        for (const listener of this.eventListeners) listener(message.event);
        return;
      }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    this.child.on("exit", (code) => {
      this.child = null;
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`Utility Process 已退出（code ${code}）`));
      }
      this.pending.clear();
    });
  }

  call<T>(
    method: string,
    payload: unknown,
    secrets?: {
      apiKey?: string;
      textModelId?: string;
      imageModelId?: string;
      videoModelRouting?: ProviderVideoRouting;
    }
  ): Promise<T> {
    this.start();
    const child = this.child;
    if (!child) return Promise.reject(new Error("Utility Process 未启动"));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      });
      child.postMessage({ id, method, payload, secrets });
    });
  }

  onAgentEvent(listener: (event: AgentUiEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }
}
