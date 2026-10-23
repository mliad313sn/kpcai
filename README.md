# KernelPAI

> **KP Studio** is the name of the KernelPAI apps — web console, desktop and terminal UI (arriving in phase 3). KernelPAI is the engine and the `kpai` command line.

A local, multi-AI development console. KernelPAI breaks every request into a task graph and routes each task to the most competent model, cloud or local. Models from different providers review each other's work. The whole chain stays visible, interruptible and budgeted.

> **Status: phase 0 (foundations).** One explicit model per call, with streaming, cost estimates, budget confirmation, Ctrl+C cancellation and a tamper-evident local journal. Routing arrives in phase 1. See [docs/PHASE-0-REPORT.md](docs/PHASE-0-REPORT.md).

## Quick start

```sh
corepack enable            # provides pnpm
pnpm install
pnpm build
pnpm demo:phase0           # offline demo, no keys needed

node apps/cli/dist/bin.js providers
node apps/cli/dist/bin.js ask -m mock/echo "hello"
export ANTHROPIC_API_KEY=...   # optional
node apps/cli/dist/bin.js ask -m anthropic/claude-haiku-5-5 --max-tokens 200 "Explain WAL mode"
node apps/cli/dist/bin.js ask -m ollama/llama3.2:3b "hi"   # with Ollama running
node apps/cli/dist/bin.js log
node apps/cli/dist/bin.js verify
```

Requires Node ≥ 22.13. Data stays in `~/.kernelpai` (override with `KPAI_HOME`).

## Layout

| Path                 | What                                                                    |
| -------------------- | ----------------------------------------------------------------------- |
| `packages/core`      | Contracts: schemas, `ProviderAdapter`/`BaseAdapter`, errors, cost       |
| `packages/journal`   | SQLite session journal (hash chain, Markdown export)                    |
| `packages/providers` | YAML provider descriptors, registry, adapters (Anthropic, Ollama, mock) |
| `apps/cli`           | The `kpai` command                                                      |
| `docs/`              | Spec, refined build prompt, landscape scan, ADRs, phase reports         |

## Adding a provider

1. Add `packages/providers/descriptors/<id>.yaml`, or `~/.kernelpai/providers/<id>.yaml` for a local-only override.
2. If no existing adapter speaks its API, write a class extending `BaseAdapter` and register it with one line in `ADAPTERS`.

## Documents

- [Master prompt and specification](docs/KERNELPAI_MASTER_PROMPT.md) (authoritative)
- [Refined build prompt](docs/BUILD_PROMPT.md)
- [Landscape scan](docs/LANDSCAPE.md)
- [ADRs](docs/adr/README.md)

## Development

`pnpm check` runs format check, lint (it enforces 400 lines per file and 50 per function), build, and tests with 80 % coverage thresholds.

License: not chosen yet (owner decision); packages are marked UNLICENSED.
