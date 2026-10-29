/**
 * What a channel receives (S10 R4 c, Q-11, ADR-0036). By default a notice is content-free:
 * the program id, the report kind, counts (decisions waiting, budget used, alerts, changes)
 * and a loopback link. No goal, question, decision, risk or file text. A channel may opt in
 * to a short summary: the asks and the top risk, passed through the redaction rules of
 * `notify.ts` (code dropped, secrets masked, local-only lines dropped, quotes cut).
 * Every notice goes through `renderNotification`, so it fits the channel's limit.
 */
import { execText } from './exec-text.js';
import type { ExecReport } from './exec-report.js';
import { renderNotification, type ChannelKind, type Notification } from './notify.js';
import type { Report } from './report.js';
import { reportText } from './report-text.js';
import type { Locale } from './schemas.js';

export interface NoticeOptions {
  /** Opt-in per channel: the asks and the top risk, redacted. Default false. */
  summary?: boolean;
  /** A loopback link to KP Studio; anything else is dropped. */
  link?: string;
}

const SUMMARY_LINES = 3;

/** A report as a channel sees it. */
export function renderNotice(
  r: ExecReport,
  channel: ChannelKind,
  o: NoticeOptions = {},
): Notification {
  const t = execText(r.locale);
  const verified = r.kind === 'final' ? ` ${t.delivery(r.verified)}` : '';
  const shell: Report = {
    ...r,
    title: t.noticeTitle(r.programId, r.kind),
    headline: `${t.counts(r.counts)}${verified}`,
    sections: o.summary
      ? r.sections
          .filter((x) => x.key === 'asks' || x.key === 'risk')
          .map((x) => ({ ...x, lines: x.lines.slice(0, SUMMARY_LINES) }))
      : [],
  };
  return renderNotification(shell, channel, o.link);
}

export interface AlertInput {
  locale: Locale;
  /** Watchdog rule ids (never their text). */
  rules?: readonly string[];
  /** The daemon's last heartbeat, when the dead-man file is stale. */
  staleSince?: string;
}

/** A watchdog alert or a dead-man staleness: rule ids and times only. */
export function renderAlertNotice(
  a: AlertInput,
  channel: ChannelKind,
  link?: string,
): Notification {
  const t = execText(a.locale);
  const parts = [
    ...(a.staleSince ? [t.staleBody(a.staleSince)] : []),
    ...(a.rules?.length ? [t.alertBody([...a.rules])] : []),
  ];
  return renderNotification(bare(a.locale, t.alertTitle, parts.join(' ')), channel, link);
}

/** `kpai notify test`: proves a channel works, with no project data. */
export function renderTestNotice(
  locale: Locale,
  channel: ChannelKind,
  link?: string,
): Notification {
  const t = execText(locale);
  return renderNotification(bare(locale, t.testTitle, t.testBody), channel, link);
}

function bare(locale: Locale, title: string, headline: string): Report {
  return {
    kind: 'digest',
    locale,
    at: new Date(0).toISOString(),
    programId: '-',
    title,
    headline,
    verified: true,
    sections: [],
    link: reportText(locale).link,
  };
}
