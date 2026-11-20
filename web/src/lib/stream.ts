import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { LiveAgentEvent } from '../../../src/api/types.js';
import type { EventRow } from '../../../src/store/types.js';

// One shared SSE connection to GET /api/stream for the whole page.

export interface StreamListener {
  onEvent?: (event: EventRow) => void;
  onAgent?: (event: LiveAgentEvent) => void;
  /** Called after a reconnect: anything may have been missed, so reload. */
  onReconnect?: () => void;
}

const listeners = new Set<StreamListener>();
const statusListeners = new Set<() => void>();
let source: EventSource | undefined;
let connected = false;
let everConnected = false;

function setConnected(value: boolean): void {
  if (connected === value) return;
  connected = value;
  for (const l of statusListeners) l();
}

function ensureConnected(): void {
  if (source) return;
  source = new EventSource('/api/stream');
  source.addEventListener('open', () => {
    setConnected(true);
    if (everConnected) for (const l of listeners) l.onReconnect?.();
    everConnected = true;
  });
  // EventSource reconnects by itself after an error.
  source.addEventListener('error', () => setConnected(false));
  source.addEventListener('event', (e) => {
    const data = JSON.parse((e as MessageEvent<string>).data) as EventRow;
    for (const l of listeners) l.onEvent?.(data);
  });
  source.addEventListener('agent', (e) => {
    const data = JSON.parse((e as MessageEvent<string>).data) as LiveAgentEvent;
    for (const l of listeners) l.onAgent?.(data);
  });
}

export function subscribe(listener: StreamListener): () => void {
  ensureConnected();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe for the lifetime of the component; the latest callbacks are always used. */
export function useStream(listener: StreamListener): void {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(
    () =>
      subscribe({
        onEvent: (e) => ref.current.onEvent?.(e),
        onAgent: (e) => ref.current.onAgent?.(e),
        onReconnect: () => ref.current.onReconnect?.(),
      }),
    [],
  );
}

export function useConnected(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      ensureConnected();
      statusListeners.add(onChange);
      return () => statusListeners.delete(onChange);
    },
    () => connected,
  );
}
