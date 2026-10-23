#!/usr/bin/env node
// node:sqlite prints an ExperimentalWarning on Node 22 (ADR-0004). Silence that one warning only.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (/SQLite is an experimental feature/.test(text)) return;
  (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

// The AI SDK logs provider warnings to stderr; the CLI reports what matters itself.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const { main } = await import('./main.js');
const { processIo } = await import('./io.js');
process.exitCode = await main(process.argv.slice(2), processIo());
