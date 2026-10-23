/**
 * Model and provider text is untrusted (spec §6). Before it reaches a terminal, drop
 * escape sequences (CSI, OSC — e.g. OSC 52 clipboard writes, screen clears) and other
 * C0/C1 control characters, keeping newlines and tabs. The journal keeps the raw text.
 */
const ESCAPES = new RegExp(
  [
    '\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\|$)', // OSC … BEL / ST
    '\\u009d[\\s\\S]*?(?:\\u0007|\\u009c|$)', // 8-bit OSC
    '\\u001b\\[[0-?]*[ -/]*[@-~]', // CSI
    '\\u009b[0-?]*[ -/]*[@-~]', // 8-bit CSI
    '\\u001b[PX^_][\\s\\S]*?(?:\\u001b\\\\|$)', // DCS, SOS, PM, APC
    '\\u001b[ -/]*[0-~]', // other ESC sequences
  ].join('|'),
  'g',
);
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function sanitizeForTerminal(text: string): string {
  return text.replace(ESCAPES, '').replace(CONTROLS, '');
}
