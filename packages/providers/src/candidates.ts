import type { Candidate, ProviderAdapter } from '@kernelpai/core';

/** A provider left out of routing, with the reason its detection gave. */
export interface UnavailableProvider {
  provider: string;
  reason: string;
}

export interface CandidateScan {
  /** One entry per model of every available provider (declared + discovered). */
  candidates: Candidate[];
  /** Skipped providers, in registry order. */
  unavailable: UnavailableProvider[];
}

/**
 * Detects every adapter (in parallel) and turns the available ones into router
 * candidates. Detection never throws past this point: a failing `detect()` marks
 * the provider unavailable with the error as its reason.
 */
export async function candidates(registry: {
  list(): readonly ProviderAdapter[];
}): Promise<CandidateScan> {
  const adapters = registry.list();
  const detections = await Promise.all(
    adapters.map((a) =>
      a.detect().catch((err: unknown) => ({ available: false, reason: String(err) })),
    ),
  );
  const scan: CandidateScan = { candidates: [], unavailable: [] };
  adapters.forEach((adapter, i) => {
    const d = adapter.descriptor;
    const det = detections[i] ?? { available: false, reason: 'not detected' };
    if (!det.available) {
      scan.unavailable.push({ provider: d.id, reason: det.reason });
      return;
    }
    for (const card of adapter.capabilities()) {
      scan.candidates.push({
        ref: { provider: d.id, model: card.id },
        providerKind: d.kind,
        jurisdiction: d.jurisdiction,
        card,
      });
    }
  });
  return scan;
}
