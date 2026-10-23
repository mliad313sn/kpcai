import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * One Node bundle (`dist/bin.js`) holding this app and the web console's store, protocol
 * client and catalogue it shares; dependencies stay external and resolve at run time.
 */
export default defineConfig({
  resolve: {
    alias: { '@kernelpai/kernel/protocol': src('../../packages/kernel/src/protocol.ts') },
  },
  // Workspace packages stay external (they are built by `tsc -b`); only the protocol module is
  // bundled from source, like in the web console.
  ssr: { external: ['@kernelpai/kernel'] },
  build: {
    ssr: 'src/bin.tsx',
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node22',
    sourcemap: false,
    rollupOptions: { output: { entryFileNames: 'bin.js', format: 'es' } },
  },
});
