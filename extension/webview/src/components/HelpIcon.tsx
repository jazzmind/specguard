import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import type { HelpTopic } from '../protocol.js';
import { vscodeApi } from '../vscode.js';
import './help.css';

/** Help topics by key, provided once by the app from the host's `helpTopics` message. */
export const HelpContext = createContext<Record<string, HelpTopic>>({});

/**
 * A small "?" button that shows a help topic's text and a Read more link into the docs panel.
 * Renders nothing when the host has no such topic.
 */
export function HelpIcon({ topic }: { topic: string }) {
  const topics = useContext(HelpContext);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const popId = useId();
  const entry = topics[topic];

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [open]);

  if (!entry) return null;
  return (
    <span className="sg-help" ref={root}>
      <button
        ref={btn}
        type="button"
        className="sg-help-btn"
        aria-label={`Help: ${entry.title}`}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => setOpen((o) => !o)}
      >?</button>
      {open && (
        <div id={popId} role="dialog" aria-label={entry.title} className="sg-help-pop">
          <strong>{entry.title}</strong>
          {entry.text}
          <button type="button" onClick={() => { setOpen(false); vscodeApi.postMessage({ type: 'openDocs', topic }); }}>Read more</button>
        </div>
      )}
    </span>
  );
}
