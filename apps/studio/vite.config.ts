import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/** Strict CSP for the production build only (Vite's dev server injects inline styles). */
const CSP = [
  "default-src 'self'",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:* ws://[::1]:*",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function csp(): Plugin {
  return {
    name: 'kernelpai-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      ),
  };
}

/** Served by packages/server from `dist`; no CDN, no remote fonts, nothing but the local WS. */
export default defineConfig({
  plugins: [react(), csp()],
  base: './',
  resolve: {
    alias: {
      // The protocol is consumed from source so the UI build does not need `tsc -b` first.
      '@kernelpai/kernel/protocol': src('../../packages/kernel/src/protocol.ts'),
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022' },
});
