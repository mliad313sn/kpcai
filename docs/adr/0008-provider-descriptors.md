# ADR-0008 — Provider descriptors in YAML

**Status:** Accepted (phase 0) · **Date:** 2026-10-23

## Decision

- One YAML per provider in `packages/providers/descriptors/`: id, kind (cloud/local/aggregator/test), `adapter` key, base URL (+ env override), auth env var, jurisdiction, retention, and model cards (context, max output, modalities, price per MTok, strengths/weaknesses by task type).
- Validated by zod at load time; errors name the file and field.
- Users can add or override providers in `$KPAI_HOME/providers/*.yaml` (same id wins).
- Local providers (`discoverModels: true`) build cards at runtime from the server's model list with `defaultLocalCard`.
- Phase 1 seeds cards from models.dev (MIT) and keeps YAML as the human-editable override layer.

## Consequences

A new OpenAI-compatible provider will need YAML only once the generic adapter exists (phase 1); a new protocol needs one adapter class plus one line in `ADAPTERS`.
