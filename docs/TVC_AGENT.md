# AI TVC Agent · Current product boundary

This document records what the application currently does. Product direction lives in [ROADMAP.md](../ROADMAP.md); implementation and tests are the final source of truth.

## Product goal

AI TVC Agent turns experience-heavy commercial production into a reusable, iterative workflow. It keeps the Brief, creative decisions, scripts, Prompts, images, video jobs, and exported assets together in a local project instead of scattering them across separate tools.

The core creative capability is script constraint:

1. Restate the commercial Brief for user confirmation.
2. Generate three distinct one-line creative directions.
3. Build a structured script using Hook, Reveal, Proof, CTA, and related advertising roles.
4. Preserve shot duration, visual Prompt, Audio & SFX, and VO as explicit fields.
5. Use the selected script as the source for image iteration or final video generation.

## Current workflow

```text
Brief
→ AI restatement and confirmation
→ three creative directions
→ five-column structured script
├─→ per-shot still images → Prompt revision → cumulative script version
└─→ selected final script → editable full-video Prompt → quote → approval
    → one exact-duration video task → download → validation → local export
```

Still images are a visual review and Prompt iteration path. They are not required inputs for final video generation.

## Implemented

- Local project folders with `project.json`, `canvas.json`, Markdown node bodies, assets, outputs, and a SQLite index.
- Brief restatement, explicit confirmation, three creative directions, and structured script generation.
- Script validation for unique shot IDs, exact total duration, required Prompt fields, and language constraints.
- Per-shot still-image generation with version history and Prompt application to cumulative script versions.
- Explicit script selection before final video generation.
- Full-video Prompt translation from the complete selected script.
- Exact-duration model validation before quoting or submission.
- Real CNY estimates and a two-step paid confirmation flow.
- Persistent video jobs, background polling, restart recovery, cancellation, retries, and retry-chain cost accounting.
- Video download, MP4 validation, atomic storage, and byte-preserving export.
- ORZ credentials encrypted with Electron `safeStorage`; Renderer cannot read stored secrets.

## Video task states

```text
draft → awaiting-approval → uploading → queued → generating
      → downloading → validating → completed
```

Recovery and terminal states: `interrupted`, `recovering`, `failed`, `canceled`, and `expired`.

Remote completion is not local completion. A task reaches `completed` only after its video has been downloaded, validated, and written to the project.

## Current video models

- `bytedance/seedance-2`
- `kuaishou/kling-2-5-turbo`

Text, image, and video requests use the ORZ gateway through adapters in `src/utility/providers/`.

## Known gaps

- UI hierarchy and visual detail need refinement.
- Floating UI selection anchoring is not implemented; the Agent panel currently uses a right-side dock.
- Semantic zoom is not implemented.
- Upstream changes do not yet propagate a `stale` state to downstream nodes.
- ProjectCommand transactions, previewable diffs, undo, and redo are not implemented.
- Agent turns do not yet expose every node and file actually read.
- Canvas edges do not carry typed relationship semantics.
- Drag, paste, and file-import node creation are incomplete.
- macOS and Windows packaged builds still require release validation.

These gaps are tracked in [ROADMAP.md](../ROADMAP.md).

## Explicit non-goals

- Professional multi-track editing.
- Per-shot video stitching as the default final-video workflow.
- Complex transitions, color grading, or lip sync.
- Premiere or Jianying project export.
- Automated legal approval or production-grade identity consistency guarantees.

## Verification

```bash
bun test tests
bun run typecheck
```

Current baseline: 193 tests pass and both TypeScript configurations are clean.
