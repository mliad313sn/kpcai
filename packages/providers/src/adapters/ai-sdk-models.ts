import type { LanguageModel } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogle } from '@ai-sdk/google';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createXai } from '@ai-sdk/xai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

/** Vercel AI SDK provider packages the generic adapter can drive. */
export const AI_SDK_NAMES = [
  'openai',
  'google',
  'mistral',
  'xai',
  'deepseek',
  'openrouter',
  'openai-compatible',
] as const;
export type AiSdkName = (typeof AI_SDK_NAMES)[number];

export interface SdkOptions {
  /** Provider id, used as the SDK provider name. */
  name: string;
  apiKey?: string;
  /** Undefined = the SDK's public default endpoint. */
  baseURL?: string;
  fetch?: typeof fetch;
}

export type ModelFactory = (modelId: string) => LanguageModel;

/**
 * One factory per SDK package. Credentials are always passed explicitly, so no SDK
 * ever falls back to reading `process.env` behind the kernel's back.
 */
const FACTORIES: Readonly<Record<AiSdkName, (o: SdkOptions) => ModelFactory>> = {
  openai: ({ name, apiKey, baseURL, fetch }) => {
    const p = createOpenAI({ name, apiKey, baseURL, fetch });
    return (id) => p.languageModel(id);
  },
  google: ({ name, apiKey, baseURL, fetch }) => {
    const p = createGoogle({ name, apiKey, baseURL, fetch });
    return (id) => p.languageModel(id);
  },
  mistral: ({ apiKey, baseURL, fetch }) => {
    const p = createMistral({ apiKey, baseURL, fetch });
    return (id) => p.languageModel(id);
  },
  xai: ({ apiKey, baseURL, fetch }) => {
    const p = createXai({ apiKey, baseURL, fetch });
    return (id) => p.languageModel(id);
  },
  deepseek: ({ apiKey, baseURL, fetch }) => {
    const p = createDeepSeek({ apiKey, baseURL, fetch });
    return (id) => p.languageModel(id);
  },
  openrouter: ({ apiKey, baseURL, fetch }) => {
    const p = createOpenRouter({ apiKey, baseURL, fetch, compatibility: 'strict' });
    return (id) => p.languageModel(id);
  },
  'openai-compatible': ({ name, apiKey, baseURL, fetch }) => {
    if (!baseURL) throw new Error(`Provider ${name}: openai-compatible needs a base URL`);
    const p = createOpenAICompatible({ name, apiKey, baseURL, fetch, includeUsage: true });
    return (id) => p.languageModel(id);
  },
};

export function isAiSdkName(s: string): s is AiSdkName {
  return (AI_SDK_NAMES as readonly string[]).includes(s);
}

export function modelFactory(sdk: AiSdkName, options: SdkOptions): ModelFactory {
  return FACTORIES[sdk](options);
}
