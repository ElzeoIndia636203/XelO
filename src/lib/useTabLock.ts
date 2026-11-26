import { useEffect, useRef, useState } from 'react';

/**
 * Coordinates single-tab ownership for an editable workspace (e.g., lab IDE or exam IDE)
 * via BroadcastChannel so a second open tab warns the user and does not silently overwrite
 * the active tab's autosave drafts.
 */
export function useTabLock(lockKey: string) {
  const tabIdRef = useRef<string>('');
  const [duplicateTabOpen, setDuplicateTabOpen] = useState(false);

  useEffect(() => {
    if (!tabIdRef.current) {
      tabIdRef.current =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`;
    }
    if (!lockKey || typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(`xeio-tab-lock:${lockKey}`);
    const myId = tabIdRef.current;

    ch.onmessage = (ev: MessageEvent<{ type?: string; from?: string }>) => {
      const msg = ev.data;
      if (!msg || msg.from === myId) return;
      if (msg.type === 'hello') {
        // An existing tab is already open; tell the newcomer it's a duplicate.
        ch.postMessage({ type: 'occupied', from: myId });
      } else if (msg.type === 'occupied') {
        setDuplicateTabOpen(true);
      } else if (msg.type === 'takeover') {
        setDuplicateTabOpen(true);
      } else if (msg.type === 'bye') {
        setDuplicateTabOpen(false);
      }
    };

    ch.postMessage({ type: 'hello', from: myId });

    return () => {
      ch.postMessage({ type: 'bye', from: myId });
      ch.close();
    };
  }, [lockKey]);

  function takeOverTab() {
    setDuplicateTabOpen(false);
    if (!lockKey || typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(`xeio-tab-lock:${lockKey}`);
    ch.postMessage({ type: 'takeover', from: tabIdRef.current });
    ch.close();
  }

  return { duplicateTabOpen, takeOverTab };
}
