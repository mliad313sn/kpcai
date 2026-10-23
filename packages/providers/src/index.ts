export { AnthropicAdapter } from './adapters/anthropic.js';
export { OllamaAdapter } from './adapters/ollama.js';
export { MockAdapter, type MockBehaviour } from './adapters/mock.js';
export {
  ADAPTERS,
  BUILTIN_DESCRIPTOR_DIR,
  ProviderRegistry,
  loadDescriptors,
  parseDescriptor,
  type AdapterFactory,
} from './registry.js';
export { resolveApiKey, resolveBaseUrl, type Env } from './env.js';
