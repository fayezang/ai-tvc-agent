# Roadmap

This is a living document describing direction and priority, not a release promise. Dates are intentionally omitted. The implementation and tests remain the source of truth.

Status vocabulary:

- **Shipped** — implemented and verified.
- **Now** — the current focus.
- **Next** — planned after the current focus.
- **Later** — useful direction without a committed schedule.

## Now

### UI refinement

- Establish a consistent visual system and clearer hierarchy across Brief, creative direction, script, storyboard, quote, generation, and export states.
- Improve canvas navigation, selection feedback, node actions, and the transition between canvas work and the Agent panel.
- Add semantic zoom so dense projects remain readable at different zoom levels.
- Use Floating UI to anchor the Agent panel and contextual actions to the current selection, with a stable dock fallback.
- Complete empty, loading, streaming, error, retry, disabled, and success states.
- Tighten keyboard navigation, reduced-motion behavior, focus visibility, and responsive panel resizing.

## Next

### Editing safety and context

- Propagate `stale` state when an upstream Brief, creative direction, script, or Prompt change invalidates downstream work.
- Introduce project commands with previewable changes, undo, and redo.
- Show the nodes and files actually used by each Agent turn.
- Add typed relationship semantics to canvas edges and make version lineage easier to inspect.
- Finish drag, paste, and file-import entry points for creating nodes.

## Later

### Release hardening

- Validate packaged builds on macOS and Windows.
- Run complete real-account TVC projects through generation and export.
- Profile large canvases and virtualize long Agent and task histories where needed.
- Add automated packaging and release checks.

## Shipped

| Phase | Outcome |
|---|---|
| 1 · Local foundation | Electron desktop app, local project format, SQLite migrations, encrypted credentials, atomic asset storage |
| 2 · Task reliability | Persistent task states, Utility Process polling, restart recovery, retries, and attempt lineage |
| 3 · Cost control | Real price estimates, quote-before-submit confirmation, retry cost accounting, and Prompt fidelity |
| 4 · TVC workflow | Brief-to-script flow, storyboard Prompt iteration, selected-script video generation, exact-duration jobs, and local MP4 export |

See [docs/KICKOFF-HISTORY.md](docs/KICKOFF-HISTORY.md) for the implementation record.

## Contributing

Use GitHub Issues for bugs and focused proposals. Large scope changes should be discussed before implementation; shipped work should update this roadmap in the same pull request.
