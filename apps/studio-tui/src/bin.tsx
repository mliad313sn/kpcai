#!/usr/bin/env node
/** `kp-studio-tui`: KP Studio in the terminal, connected to a running `kpai studio`. */
import { render } from 'ink';
import { connect, disconnect } from '../../studio/src/connection';
import { setLocale, systemLocale, t } from '../../studio/src/i18n/core';
import { patch } from '../../studio/src/store/store';
import { TuiApp } from './App';
import { locate, parseArgs } from './locate';

const args = parseArgs(process.argv.slice(2));
setLocale(args.lang ?? systemLocale());
if (args.help) {
  process.stdout.write(`${t('tui.usage')}\n`);
  process.exit(0);
}
const where = locate(args, process.env);
if (!where.ok) {
  process.stderr.write(`${t(where.reason === 'badUrl' ? 'tui.badUrl' : 'tui.noServer')}\n`);
  process.exit(2);
}
// The terminal has no first-run screen: onboarding is the web console's (R-308).
patch({ onboardingOpen: false });
connect(where.url, where.token, { clientName: 'kp-studio-tui' });
const app = render(<TuiApp />, { exitOnCtrlC: false });
await app.waitUntilExit();
disconnect();
process.exit(0);
