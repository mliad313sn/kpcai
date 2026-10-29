# Phase 6 plan — Hardening, trust and compliance

Owner: Product Owner · Started 2026-10-29 · Exit criteria:

- `docs/BUILD_PROMPT.md` phase 6: forbidden zones, key vault, audit, encryption at rest, WCAG 2.2 AA accessibility, performance, macOS and Linux packages;
- the Must items R-601..R-607 and R-609 of [REQUIREMENTS-KP-STUDIO.md](../REQUIREMENTS-KP-STUDIO.md);
- R-6E1..R-6E5 of [design/ENTERPRISE-MODE.md §17](../design/ENTERPRISE-MODE.md);
- the phase 6 backlog items B-30..B-45.

## Goals

1. **Contain what runs.**
   - An OS sandbox for `shell.run`, `test.run`, hooks, MCP servers and agent CLIs: bubblewrap or Landlock on Linux, Seatbelt on macOS, a restricted token and job object on Windows, with a confirmed fallback where none is available.
   - Network egress jailed per process (closes the ADR-0032 limit and B-34 L9).
   - Air-gap mode as one switch (R-602).
   - No bypass mode anywhere (R-605).
2. **Protect what is stored.**
   - Secrets in the OS keychain, including channel secrets (R-607, R-6E6).
   - Secret scanning on model inputs and outputs.
   - The journal and memory encrypted at rest, with the key in the keychain.
   - Sensitive work stays local (R-601).
3. **Prove what happened.**
   - Provenance export: Agent Trace records, git notes under `refs/notes/kpai`, a CycloneDX AIBOM, and commit trailers naming the run (R-603).
   - EU AI Act Article 50 labelling and a transparency notice (R-604).
   - An audit export.
4. **Supply chain** (R-606).
   - A CycloneDX SBOM of KP Studio on every CI run.
   - Provenance attestations.
   - Release signing set up for the Sponsor to run. Signing itself stays Sponsor-reserved.
5. **Remote approvals, opt-in** (R-6E1..R-6E5).
   - Loopback only by default; TLS plus passkeys or device pairing.
   - Signed single-use links bound to one escalation.
   - Sponsor-reserved items are never approved remotely (Q-12 default).
   - A full audit trail, and its own independent security review.
6. **Make phase 5 work count.**
   - Trusted dependency installation before the baseline (B-44).
   - A CI evidence source for the daemon (B-39) and `program.merge` (B-35), so delivered work can reach V2 and count as DVO.
7. **Ready to package.**
   - The desktop app bundled with its Node runtime as macOS and Linux packages, unsigned until the Sponsor signs.
   - Performance budgets checked in CI, plus WCAG 2.2 AA (R-609).

## Safety rules for this phase

- Hardening may only narrow. A sandbox that is unavailable falls back to asking every time, never to running silently.
- Keys never leave the keychain in clear form, are never logged or journaled, and tests use a fake keychain.
- Remote approval is off unless the Sponsor turns it on, and it never covers Sponsor-reserved items.
- Tests never touch the real network: fake remotes, fake keychains and fake attestation services.

## Work packages

Wave 1:

- **WP1 (S5): sandbox and egress jail.**
  - Linux first (bubblewrap/Landlock), then macOS Seatbelt and Windows job objects.
  - Per-process egress proxy enforced inside the sandbox.
  - Air-gap switch (R-602).
  - Red-team suite for R-605.
- **WP2 (S7): secrets and data at rest.**
  - Keychain vault, with a fake keychain for tests.
  - Secret scanning on model I/O.
  - Encryption at rest of the journal and memory, with key rotation.
  - Sensitive-path routing (R-601).
  - Wave 1 Lows B-34.
- **WP3 (S1): provenance and transparency.**
  - Agent Trace records, git notes, CycloneDX AIBOM, commit trailers (R-603).
  - Article 50 labels and the transparency notice (R-604).
  - Audit export.
  - The `confirm.request` facts (B-45).

Wave 2:

- **WP4 (S1, S8): make program work count.** B-35, B-39, B-44.
- **WP5 (S1, S7): remote approval layer** (R-6E1..R-6E4), followed by its own independent review (R-6E5).
- **WP6 (S8): supply chain** (R-606), performance budgets in CI, and the accessibility sweep (R-609).
- **WP7 (S6): packaging and the rest of the backlog.** Desktop packages for macOS and Linux with the runtime; terminal tiers (B-42).
- **WP8 (PO):** independent review, report and gate.
