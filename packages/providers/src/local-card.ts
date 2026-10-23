import { ModelCardSchema, type ModelCard, type ProviderDescriptor } from '@kernelpai/core';

/**
 * Builds the capability card of a model found at runtime on a local server:
 * conservative built-in limits, overridden by the descriptor's `defaultLocalCard`.
 */
export function localCard(descriptor: ProviderDescriptor, id: string): ModelCard {
  return ModelCardSchema.parse({
    contextWindow: 8192,
    maxOutput: 4096,
    modalities: ['text', 'code'],
    price: { inputPerMTok: 0, outputPerMTok: 0 },
    ...descriptor.defaultLocalCard,
    id,
  });
}
