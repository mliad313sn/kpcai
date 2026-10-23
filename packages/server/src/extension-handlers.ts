/**
 * Protocol handlers for skills, named agents, hooks and local tickets (R-502, ADR-0033).
 * Ticket text reaches clients as untrusted data; a status is written only after the human
 * confirms the exact new file through `confirm.request`.
 */
import { ticketSummary, type Kernel } from '@kernelpai/kernel';
import type { Handlers } from './handlers.js';

type ExtensionMethod = 'extensions.list' | 'tickets.list' | 'tickets.show' | 'tickets.setStatus';

export function extensionHandlers(kernel: Kernel): Pick<Handlers, ExtensionMethod> {
  return {
    'extensions.list': () => kernel.extensions(),
    'tickets.list': async () => {
      const r = await kernel.tickets.list();
      return { tickets: r.tickets.map(ticketSummary), problems: r.problems };
    },
    'tickets.show': async (p) => {
      const r = await kernel.tickets.forRun(p.id);
      return { ticket: ticketSummary(r.ticket), request: r.request, options: r.options };
    },
    'tickets.setStatus': (p) => kernel.tickets.setStatus(p.id, p.status, p.runId),
  };
}
