import { useState } from 'react';
import type { GraphNode } from '../rpc/schemas';
import { submit } from '../store/actions';
import { COMMANDS, tokenAtCaret } from '../store/commands';
import { useStudio } from '../store/store';
import { graphView } from './view';

export interface Suggestion {
  insert: string;
  label: string;
  hint: string;
}

/** Suggestions for the token at the caret: `/` commands, `#` nodes, `@` files (later). */
export function suggestionsFor(
  text: string,
  caret: number,
  nodes: readonly GraphNode[],
): Suggestion[] {
  const t = tokenAtCaret(text, caret);
  if (!t) return [];
  const prefix = t.prefix.toLowerCase();
  if (t.sigil === '/')
    return COMMANDS.filter((c) => c.name.startsWith(prefix)).map((c) => ({
      insert: `/${c.name} `,
      label: `/${c.name}`,
      hint: c.hint,
    }));
  if (t.sigil === '#')
    return nodes
      .filter((n) => n.id.toLowerCase().startsWith(prefix))
      .map((n) => ({ insert: `#${n.id} `, label: `#${n.id}`, hint: n.title }));
  return []; // `@` files: the explorer's file tree arrives with the tool bus UI (phase 5).
}

const NO_NODES: GraphNode[] = [];

function useCommandInput() {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const nodes = useStudio((s) => graphView(s)?.graph.nodes ?? NO_NODES);
  const list = dismissed ? [] : suggestionsFor(text, caret, nodes);
  const choose = (sug: Suggestion) => {
    const t = tokenAtCaret(text, caret);
    const next = t ? text.slice(0, t.start) + sug.insert + text.slice(caret) : text;
    setText(next);
    setCaret(next.length);
    setActive(0);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!list.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (a + d + list.length) % list.length);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      choose(list[Math.min(active, list.length - 1)]!);
    } else if (e.key === 'Escape') setDismissed(true);
  };
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setText(e.target.value);
    setCaret(e.target.selectionStart ?? e.target.value.length);
    setActive(0);
    setDismissed(false);
  };
  return { text, setText, setCaret, active, list, choose, onKeyDown, onChange };
}

function Suggestions(props: {
  list: Suggestion[];
  active: number;
  choose: (s: Suggestion) => void;
}) {
  return (
    <ul id="command-suggestions" role="listbox" className="suggestions" hidden={!props.list.length}>
      {props.list.map((sug, i) => (
        <li
          key={sug.label}
          id={`sug-${i}`}
          role="option"
          aria-selected={i === props.active}
          onMouseDown={(e) => {
            e.preventDefault();
            props.choose(sug);
          }}
        >
          <span className="mono">{sug.label}</span> <span className="muted">{sug.hint}</span>
        </li>
      ))}
    </ul>
  );
}

export function CommandBar() {
  const c = useCommandInput();
  const planning = useStudio((s) => s.planning);
  const conn = useStudio((s) => s.conn);
  const open = c.list.length > 0;
  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await submit(c.text)) c.setText('');
  };
  return (
    <form className="command-bar" role="search" aria-label="Command bar" onSubmit={onSubmit}>
      <label htmlFor="command-input" className="sr-only">
        Ask KP Studio, or type / for commands, @ for files, # for nodes, ! for the terminal
      </label>
      <input
        id="command-input"
        type="text"
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={open}
        aria-controls="command-suggestions"
        aria-autocomplete="list"
        aria-activedescendant={open ? `sug-${c.active}` : undefined}
        aria-describedby="command-help"
        placeholder="Describe a task…  / commands · @ files · # nodes · ! terminal · Ctrl+K palette"
        value={c.text}
        onChange={c.onChange}
        onSelect={(e) => c.setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={c.onKeyDown}
      />
      <button type="submit" disabled={planning || conn !== 'open' || !c.text.trim()}>
        {planning ? 'Planning…' : 'Plan'}
      </button>
      <span id="command-help" className="sr-only">
        Enter plans the request; nothing runs before you press Run.
        {c.text.trim().startsWith('!') ? ' Terminal request: sent to the planner in phase 3.' : ''}
      </span>
      <Suggestions list={c.list} active={c.active} choose={c.choose} />
    </form>
  );
}
