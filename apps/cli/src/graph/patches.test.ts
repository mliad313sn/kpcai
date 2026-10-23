import { describe, expect, it } from 'vitest';
import { extractPatches, patchFiles } from './patches.js';

const DIFF =
  'diff --git a/x.ts b/x.ts\nnew file mode 100644\n--- /dev/null\n+++ b/x.ts\n@@ -0,0 +1 @@\n+hi\n';

describe('extractPatches', () => {
  it('takes fenced diff blocks', () => {
    const text = `Here:\n\`\`\`diff\n${DIFF}\`\`\`\nand\n\`\`\`patch\n${DIFF.replaceAll('x.ts', 'y.ts')}\`\`\``;
    expect(extractPatches(text).map(patchFiles)).toEqual([['x.ts'], ['y.ts']]);
  });

  it('takes a bare diff after prose', () => {
    expect(extractPatches(`Sure.\n${DIFF}`)).toEqual([DIFF]);
  });

  it('ignores text without hunks and fenced non-diffs', () => {
    expect(extractPatches('--- just a line\nno hunk')).toEqual([]);
    expect(extractPatches('```ts\nconst a = 1;\n```')).toEqual([]);
    expect(extractPatches('nothing here')).toEqual([]);
  });

  it('adds a final newline git apply needs', () => {
    expect(extractPatches(DIFF.trimEnd())[0]?.endsWith('\n')).toBe(true);
  });
});
