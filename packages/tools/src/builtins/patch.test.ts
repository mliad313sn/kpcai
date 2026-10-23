import { describe, expect, it } from 'vitest';
import { assertPrintable, checkSections, parseNumstat, parsePatch, summaryModes } from './patch.js';

const hunk = (file: string, from = 'one', to = 'two') =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    `-${from}`,
    `+${to}`,
  ].join('\n');

describe('assertPrintable (P2-F1)', () => {
  it.each([
    ['ESC (OSC title)', '+// tidy \x1b]0;\n'],
    ['BEL', '+x \x07\n'],
    ['backspace', '+safe\x08\x08\x08\x08evil\n'],
    ['DEL', '+a\x7f\n'],
    ['C1 CSI', '+a\u009b2J\n'],
    ['bidi override', '+const ok = "‮" // looks fine\n'],
    ['NUL', '+a\0b\n'],
  ])('refuses %s without echoing the byte', (_name, body) => {
    const patch = `${hunk('a.ts')}\n${body}`;
    let message = '';
    try {
      assertPrintable(patch);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/control character U\+[0-9A-F]{4} at line 7, column \d+/);
    // eslint-disable-next-line no-control-regex
    expect(message).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/);
  });

  it('accepts tabs, LF, and consistently CRLF patches', () => {
    expect(() => assertPrintable(`${hunk('a.ts')}\n+\tindented\n`)).not.toThrow();
    expect(() => assertPrintable(`${hunk('a.ts')}\n`.replace(/\n/g, '\r\n'))).not.toThrow();
  });

  it('refuses stray carriage returns and mixed line endings', () => {
    expect(() => assertPrintable(`${hunk('a.ts')}\n+hidden\rshown\n`)).toThrow(/U\+000D/);
    expect(() => assertPrintable('a\r\nb\nc\r\n')).toThrow(/mixes CRLF and LF/);
  });
});

describe('parsePatch / checkSections (P2-F2)', () => {
  it('splits git and plain multi-file patches, counting hunk lines', () => {
    // The removed line "-- x" inside the hunk must not start a new section.
    const plain = [
      '--- a/x.txt',
      '+++ b/x.txt',
      '@@ -1,2 +1,1 @@',
      '--- x',
      ' keep',
      '--- a/y.txt',
      '+++ b/y.txt',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    const s = parsePatch(plain);
    expect(s.map((x) => [x.paths, x.hunks])).toEqual([
      [['x.txt', 'x.txt'], 1],
      [['y.txt', 'y.txt'], 1],
    ]);
    const git = parsePatch(`${hunk('a.ts')}\n${hunk('b.ts')}\n`);
    expect(git.map((x) => x.paths[0])).toEqual(['a.ts', 'b.ts']);
  });

  it('records modes, binary, deletions and renames', () => {
    const p = [
      hunk('a.txt'),
      'diff --git a/tools/setup.sh b/tools/setup.sh',
      'new file mode 100755',
      'GIT binary patch',
      'literal 3',
      'abc',
      '',
      'diff --git a/old.txt b/old.txt',
      'deleted file mode 100644',
      '--- a/old.txt',
      '+++ /dev/null',
      'diff --git a/m.txt b/n.txt',
      'similarity index 100%',
      'rename from m.txt',
      'rename to n.txt',
      'diff --git a/x b/x',
      'Binary files a/x and b/x differ',
    ].join('\n');
    const [, bin, del, ren, bin2] = parsePatch(p);
    expect(bin).toMatchObject({
      binary: true,
      modes: ['100755'],
      paths: ['tools/setup.sh', 'tools/setup.sh'],
    });
    expect(del).toMatchObject({ deleted: true, hunks: 0 });
    expect(ren).toMatchObject({ renamed: true, paths: ['m.txt', 'n.txt', 'm.txt', 'n.txt'] });
    expect(bin2?.binary).toBe(true);
    expect(() => checkSections([del, ren] as never)).not.toThrow();
  });

  it.each([
    ['binary', 'diff --git a/b b/b\nGIT binary patch\nliteral 1\nx\n', /binary patch refused/],
    [
      'executable',
      'diff --git a/r.sh b/r.sh\nnew file mode 100755\n--- /dev/null\n+++ b/r.sh\n@@ -0,0 +1 @@\n+x\n',
      /executable/,
    ],
    [
      'symlink',
      'diff --git a/l b/l\nnew file mode 120000\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+../x\n',
      /symlink/,
    ],
    [
      'empty new file',
      'diff --git a/e b/e\nnew file mode 100644\nindex 0000000..e69de29\n',
      /without a text hunk/,
    ],
    [
      'mode-only change',
      'diff --git a/m b/m\nold mode 100644\nnew mode 100600\n',
      /without a text hunk/,
    ],
  ])('refuses %s sections by default', (_name, patch, re) => {
    expect(() => checkSections(parsePatch(patch))).toThrow(re);
  });

  it('options allow binary, executable and symlink sections', () => {
    const exe = parsePatch(
      'diff --git a/r.sh b/r.sh\nnew file mode 100755\n--- /dev/null\n+++ b/r.sh\n@@ -0,0 +1 @@\n+x\n',
    );
    expect(() => checkSections(exe, { allowExecutable: true })).not.toThrow();
    const bin = parsePatch('diff --git a/b b/b\nGIT binary patch\nliteral 1\nx\n');
    expect(() => checkSections(bin, { allowBinary: true })).not.toThrow();
    const link = parsePatch(
      'diff --git a/l b/l\nnew file mode 120000\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+t\n',
    );
    expect(() => checkSections(link, { allowSymlinks: true })).not.toThrow();
  });

  it('refuses unusable headers', () => {
    expect(() => parsePatch('just text')).toThrow(/no file headers/);
    expect(() => parsePatch('diff --git "a/x y" "b/x y"\n')).toThrow(
      /unsupported diff --git header/,
    );
    expect(() => parsePatch('--- x\n+++ y\n')).toThrow(/a\/ or b\//);
    expect(() => parsePatch('--- a/x\n+++ b/x\n@@ nonsense @@\n')).toThrow(/malformed hunk/);
  });
});

describe('git apply output parsing', () => {
  it('reads numstat -z, including binary entries and the rename form', () => {
    expect(parseNumstat('1\t1\ta.txt\0-\t-\ttools/setup.sh\0')).toEqual({
      paths: ['a.txt', 'tools/setup.sh'],
      binary: ['tools/setup.sh'],
    });
    expect(parseNumstat('0\t0\t\0old.txt\0new.txt\0').paths).toEqual(['old.txt', 'new.txt']);
  });

  it('reads modes from --summary', () => {
    const out =
      ' create mode 100755 tools/setup.sh\n mode change 100644 => 120000 l\n rename a => b (100%)\n';
    expect(summaryModes(out)).toEqual(['100755', '120000']);
  });
});
