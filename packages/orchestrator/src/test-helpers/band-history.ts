import type { ChatMessage } from '@kernelpai/core';
import { Journal } from '@kernelpai/journal';

/** One journaled call + response. */
export interface Sample {
  out: number;
  type?: string;
  role?: string;
  provider?: string;
  stop?: string;
  /** Tool rounds already in the conversation; with `tools`, the call offered tools. */
  round?: number;
  tools?: boolean;
  /** Characters of the trailing tool result. */
  result?: number;
  /** Reported input tokens (the estimate is always 100). Default 100. */
  input?: number;
}

export function history(samples: Sample[]): Journal {
  const journal = Journal.open(':memory:');
  const sessionId = journal.startSession('band', '/');
  samples.forEach((x, i) => {
    const base = { sessionId, nodeId: 'n', provider: x.provider ?? 'a', model: 'm' };
    const messages: ChatMessage[] = [{ role: 'user', content: 'q' }];
    for (let k = 0; k < (x.round ?? 0); k++) {
      messages.push(
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: `t${k}`, name: 'fs.read', input: {} }],
        },
        { role: 'tool', content: 'r'.repeat(x.result ?? 0), toolCallId: `t${k}` },
      );
    }
    const request = { model: 'm', messages, ...(x.tools ? { tools: [{ name: 'fs.read' }] } : {}) };
    const requestId = `r${i}`;
    const payload = {
      requestId,
      taskType: x.type ?? 'analysis',
      request,
      role: x.role,
      estimatedInputTokens: 100,
    };
    journal.append({ ...base, type: 'call', payload });
    journal.append({
      ...base,
      type: 'response',
      payload: {
        requestId,
        inputTokens: x.input ?? 100,
        outputTokens: x.out,
        usageBasis: 'reported',
        stopReason: x.stop,
      },
    });
  });
  return journal;
}
