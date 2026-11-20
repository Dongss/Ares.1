import { useCallback, useEffect, useRef, useState } from 'react';
import type { EventRow } from '../../../src/store/types.js';
import { useStream } from './stream.js';

export interface Resource<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
}

/** Fetch on mount and whenever `key` changes; keeps showing the old data while reloading. */
export function useResource<T>(fetcher: () => Promise<T>, key: string): Resource<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` identifies what the fetcher loads
  const reload = useCallback(() => {
    const mine = ++generation.current;
    setLoading(true);
    fetcherRef.current().then(
      (value) => {
        if (mine !== generation.current) return;
        setData(value);
        setError(undefined);
        setLoading(false);
      },
      (err: unknown) => {
        if (mine !== generation.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      },
    );
  }, [key]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, loading, reload };
}

/** Call `reload` (debounced) when a matching event arrives on the live stream, or after a reconnect. */
export function useReloadOn(reload: () => void, match: (e: EventRow) => boolean, delayMs = 200) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const schedule = () => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      reload();
    }, delayMs);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useStream({
    onEvent: (e) => {
      if (match(e)) schedule();
    },
    onReconnect: schedule,
  });
}

/** Re-render every `ms` milliseconds, for running clocks. */
export function useTick(ms: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, enabled]);
  return now;
}

/** Wrap an async action: tracks busy state and the last error message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = useCallback(async <T>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(undefined);
    try {
      return await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clearError: () => setError(undefined) };
}
