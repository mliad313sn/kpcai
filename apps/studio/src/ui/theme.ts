/**
 * Colour tokens for both themes. They live here as data (not only in CSS) so the test suite
 * checks every text/background pair against WCAG 2.2 AA, and are applied as CSS custom
 * properties through the CSSOM (allowed by the strict CSP, unlike inline style attributes).
 */
export const THEMES = {
  dark: {
    bg: '#111418',
    surface: '#1a1f26',
    raised: '#232a33',
    border: '#768390',
    text: '#e6e9ee',
    muted: '#a8b1bd',
    accent: '#7cb7ff',
    accentText: '#0b1a2e',
    ok: '#6fd58f',
    warn: '#f2c14e',
    danger: '#ff9492',
    focus: '#ffd166',
    added: '#16331f',
    removed: '#3d1a1c',
    local: '#c9a7ff',
    api: '#7cd4e8',
    sub: '#ffb37a',
  },
  light: {
    bg: '#ffffff',
    surface: '#f6f8fa',
    raised: '#eaeef2',
    border: '#6e7781',
    text: '#1b1f24',
    muted: '#57606a',
    accent: '#0757c2',
    accentText: '#ffffff',
    ok: '#116329',
    warn: '#8a5a00',
    danger: '#c4202f',
    focus: '#8a3ffc',
    added: '#dafbe1',
    removed: '#ffebe9',
    local: '#6f36b0',
    api: '#006577',
    sub: '#8f4500',
  },
} as const;
export type ThemeName = keyof typeof THEMES;
export type Token = keyof (typeof THEMES)['dark'];

/** Pairs (foreground, background) the UI draws text with; each must reach 4.5:1. */
export const TEXT_PAIRS: Array<[Token, Token]> = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['text', 'raised'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['muted', 'raised'],
  ['accent', 'bg'],
  ['accent', 'surface'],
  ['accentText', 'accent'],
  ['ok', 'surface'],
  ['warn', 'surface'],
  ['danger', 'surface'],
  ['ok', 'raised'],
  ['warn', 'raised'],
  ['danger', 'raised'],
  ['ok', 'bg'],
  ['warn', 'bg'],
  ['danger', 'bg'],
  ['text', 'added'],
  ['text', 'removed'],
  // Model sources in the Enterprise view (local, API, subscription).
  ['local', 'surface'],
  ['local', 'bg'],
  ['local', 'raised'],
  ['api', 'surface'],
  ['api', 'bg'],
  ['api', 'raised'],
  ['sub', 'surface'],
  ['sub', 'bg'],
  ['sub', 'raised'],
];
/** Non-text UI (borders of controls, focus ring) needs 3:1 (WCAG 1.4.11). */
export const UI_PAIRS: Array<[Token, Token]> = [
  ['border', 'bg'],
  ['border', 'surface'],
  ['focus', 'bg'],
  ['focus', 'surface'],
];

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export function resolveTheme(pref: 'system' | ThemeName, prefersDark: boolean): ThemeName {
  return pref === 'system' ? (prefersDark ? 'dark' : 'light') : pref;
}

export function applyTheme(root: HTMLElement, theme: ThemeName, density: string): void {
  for (const [k, v] of Object.entries(THEMES[theme])) root.style.setProperty(`--${k}`, v);
  root.dataset.theme = theme;
  root.dataset.density = density;
  root.style.colorScheme = theme;
}
