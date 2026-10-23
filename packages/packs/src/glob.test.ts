import { describe, expect, it } from 'vitest';
import { globToRegExp, literalLength, matchesAny, matchesGlob } from './glob.js';

describe('matchesGlob', () => {
  it('matches a bare glob at any depth', () => {
    expect(matchesGlob('src/a.ipynb', '*.ipynb')).toBe(true);
    expect(matchesGlob('a/b/c/platformio.ini', 'platformio.ini')).toBe(true);
    expect(matchesGlob('a/b.txt', '*.ipynb')).toBe(false);
  });

  it('treats a slashless glob as a segment match, not a path match', () => {
    expect(matchesGlob('project.godot', 'project.godot')).toBe(true);
    expect(matchesGlob('x/project.godot/y', 'project.godot')).toBe(true);
  });

  it('matches ** at any depth and covers the folder itself', () => {
    expect(matchesGlob('detections/win/rule.yml', 'detections/**')).toBe(true);
    expect(matchesGlob('detections', 'detections/**')).toBe(true);
    expect(matchesGlob('other/detections', 'detections/**')).toBe(false);
  });

  it('honours case sensitivity', () => {
    expect(matchesGlob('SECRET.key', '*secret*', false)).toBe(false);
    expect(matchesGlob('SECRET.key', '*secret*', true)).toBe(true);
  });

  it('refuses .. traversal in a path glob it compiles', () => {
    expect(globToRegExp('a/b').test('a/b')).toBe(true);
    expect(matchesAny('a/b', ['a/b', 'c/*'])).toBe(true);
  });

  it('measures literal length for breadth checks', () => {
    expect(literalLength('*')).toBe(0);
    expect(literalLength('**/*secret*')).toBe(6);
    expect(literalLength('detections/**')).toBeGreaterThanOrEqual(10);
  });
});
