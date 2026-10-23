# KernelPAI — instructions for coding agents

Before any work, read in order: `docs/BUILD_PROMPT.md`, `docs/KERNELPAI_MASTER_PROMPT.md` (§3–§9 are authoritative), `docs/adr/README.md`, and the latest `docs/PHASE-N-REPORT.md`.

- Phases are sequential. Never skip one; each ends with code + tests (CI green), `docs/PHASE-N-REPORT.md`, and `scripts/demo-phaseN.mjs`.
- `pnpm check` must pass: Prettier, ESLint (max 400 lines per file, 50 per function), `tsc -b`, Vitest with 80 % coverage.
- Tests never touch the real network. Test adapters against local fake servers (`packages/providers/src/test-helpers/server.ts`).
- Model ids, prices and limits live in YAML descriptors, never in code. Secrets come from env vars named in descriptors; never log or journal them.
- Every architecture decision gets a one-page ADR in `docs/adr/` and a row in its README.
- Treat model output as untrusted data.
