import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './errors';

export function useLoad<T>(loader: () => Promise<T>, deps: readonly unknown[]) {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({
    data: null,
    loading: true,
    error: null,
  });
  const [tick, setTick] = useState(0);
  const seqRef = useRef(0);
  const loaderRef = useRef(loader);
  const depsKey = JSON.stringify(deps);

  useEffect(() => {
    loaderRef.current = loader;
  });

  useEffect(() => {
    const seq = ++seqRef.current;
    let active = true;
    Promise.resolve()
      .then(() => {
        if (active && seq === seqRef.current) {
          setState((prev) => ({ ...prev, loading: true, error: null }));
        }
        return loaderRef.current();
      })
      .then((result) => {
        if (active && seq === seqRef.current) {
          setState({ data: result, loading: false, error: null });
        }
      })
      .catch((err: unknown) => {
        if (active && seq === seqRef.current) {
          setState((prev) => ({ ...prev, loading: false, error: errorMessage(err) }));
        }
      });
    return () => {
      active = false;
    };
  }, [depsKey, tick]);

  const reload = useCallback(() => {
    setTick((t) => t + 1);
  }, []);

  return { ...state, reload };
}

export function useAction<A extends unknown[], R>(action: (...args: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        const res = await action(...args);
        return res;
      } catch (err) {
        setError(errorMessage(err));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [action],
  );

  const clear = useCallback(() => {
    setError(null);
    setMessage(null);
  }, []);

  return { run, busy, error, message, setMessage, clear };
}

export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(new Date());
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);

  return now;
}
