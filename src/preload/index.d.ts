import type { DesktopApi } from "../shared/contracts.js";

declare global {
  interface Window {
    agentApp: DesktopApi;
  }
}

export {};
