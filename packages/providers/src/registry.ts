import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  ProviderDescriptorSchema,
  ProviderError,
  type ProviderAdapter,
  type ProviderDescriptor,
} from '@kernelpai/core';
import { AiSdkAdapter } from './adapters/ai-sdk.js';
import { AI_SDK_NAMES } from './adapters/ai-sdk-models.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { MockAdapter } from './adapters/mock.js';
import { OllamaAdapter } from './adapters/ollama.js';
import type { Env } from './env.js';

export type AdapterFactory = (d: ProviderDescriptor, env: Env) => ProviderAdapter;

/** Adapter classes by the `adapter:` key of a descriptor. One line per new adapter. */
export const ADAPTERS: Readonly<Record<string, AdapterFactory>> = {
  anthropic: (d, env) => new AnthropicAdapter(d, env),
  ollama: (d, env) => new OllamaAdapter(d, env),
  mock: (d) => new MockAdapter(d),
  // One generic class, one key per AI SDK package: `adapter: ai-sdk:openai`, ...
  ...Object.fromEntries(
    AI_SDK_NAMES.map((sdk): [string, AdapterFactory] => [
      `ai-sdk:${sdk}`,
      (d, env) => new AiSdkAdapter(d, env, sdk),
    ]),
  ),
};

export const BUILTIN_DESCRIPTOR_DIR = fileURLToPath(new URL('../descriptors/', import.meta.url));

export function parseDescriptor(source: string, origin: string): ProviderDescriptor {
  const result = ProviderDescriptorSchema.safeParse(parseYaml(source));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid provider descriptor ${origin}: ${issues}`);
  }
  return result.data;
}

/** A loaded descriptor and the file it came from. */
export interface DescriptorOrigin {
  descriptor: ProviderDescriptor;
  /** The YAML file that won (the last directory that defines this id). */
  path: string;
  /** The directory of that file, as passed in `dirs`. */
  dir: string;
  /** The file of an earlier directory this one replaced, if any (a user override). */
  overrides?: string;
}

/**
 * Loads every *.yaml in the given directories; later directories override earlier
 * ids. Each entry says where it came from, so a CLI can show user overrides (F8).
 */
export interface LoadOptions {
  /**
   * Called for an invalid file instead of throwing. Use it for user directories, so one
   * bad override is skipped with a warning rather than breaking every command (review N4).
   * Built-in descriptors should stay strict.
   */
  onInvalid?: (path: string, error: Error) => void;
}

function readDescriptor(path: string, options: LoadOptions): ProviderDescriptor | undefined {
  try {
    return parseDescriptor(readFileSync(path, 'utf8'), path);
  } catch (err) {
    if (!options.onInvalid) throw err;
    options.onInvalid(path, err instanceof Error ? err : new Error(String(err)));
    return undefined;
  }
}

export function loadDescriptorsWithOrigin(
  dirs: readonly string[],
  options: LoadOptions = {},
): DescriptorOrigin[] {
  const byId = new Map<string, DescriptorOrigin>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort()) {
      const path = join(dir, file);
      const descriptor = readDescriptor(path, options);
      if (!descriptor) continue;
      const previous = byId.get(descriptor.id);
      byId.set(descriptor.id, {
        descriptor,
        path,
        dir,
        ...(previous ? { overrides: previous.path } : {}),
      });
    }
  }
  return [...byId.values()];
}

/** Loads every *.yaml in the given directories; later directories override earlier ids. */
export function loadDescriptors(
  dirs: readonly string[],
  options: LoadOptions = {},
): ProviderDescriptor[] {
  return loadDescriptorsWithOrigin(dirs, options).map((o) => o.descriptor);
}

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(descriptors: readonly ProviderDescriptor[], env: Env, factories = ADAPTERS) {
    for (const d of descriptors) {
      const factory = factories[d.adapter];
      if (!factory) throw new Error(`Provider ${d.id}: no adapter named "${d.adapter}"`);
      this.adapters.set(d.id, factory(d, env));
    }
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  get(providerId: string): ProviderAdapter {
    const a = this.adapters.get(providerId);
    if (!a) throw new ProviderError('bad_request', providerId, `Unknown provider "${providerId}"`);
    return a;
  }

  /** Resolves "provider/model" (model ids may themselves contain slashes or colons). */
  resolve(ref: string): { adapter: ProviderAdapter; model: string } {
    const slash = ref.indexOf('/');
    if (slash <= 0 || slash === ref.length - 1) {
      throw new ProviderError(
        'bad_request',
        'kernel',
        `Model reference must be "provider/model", got "${ref}"`,
      );
    }
    return { adapter: this.get(ref.slice(0, slash)), model: ref.slice(slash + 1) };
  }
}
