# 0001 · Generation uses the ORZ gateway

- Status: accepted
- Date: 2026-08-30

## Context

The desktop application needs one boundary for text, image, and video generation while keeping provider credentials and network access outside the Renderer process.

## Decision

1. Text, image, and video requests use the ORZ REST gateway.
2. Model-specific request shapes live in `src/utility/providers/`; product and UI code do not branch on provider payload formats.
3. The API key is encrypted with Electron `safeStorage` and used only by trusted processes.
4. Paid video generation is split into quote preparation and explicit approval.
5. The selected complete script is translated into one full-video Prompt and submitted as one exact-duration task.
6. Storyboard images are optional Prompt-iteration assets, not required video references.
7. A remote output URL is temporary metadata. Completion requires download, MP4 validation, and atomic local storage.
8. Export copies the selected, already validated MP4 to the user-selected path. It does not concatenate or transcode shots.

## Consequences

- The Renderer only calls typed IPC methods.
- Unsupported exact durations fail before quoting or submission.
- Task state, estimate snapshots, retries, and local paths remain auditable in SQLite.
- Provider changes stay isolated behind the adapter registry.
- Professional editing and media composition require a separate future decision.
