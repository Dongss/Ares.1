import { useCallback, useRef, useState } from 'react';
import type { RunSummary } from '../../../src/api/types.js';
import { type NotifyPref, type NotifyState, noticeFor, notifyState } from './notify.js';
import { navigate } from './router.js';
import { useStream } from './stream.js';

const PREF_KEY = 'ares1.notifications';

function readPref(): NotifyPref {
  try {
    const v = window.localStorage.getItem(PREF_KEY);
    return v === 'on' || v === 'off' ? v : null;
  } catch {
    return null;
  }
}

function writePref(pref: 'on' | 'off'): void {
  try {
    window.localStorage.setItem(PREF_KEY, pref);
  } catch {
    // private mode etc.: the choice just is not remembered
  }
}

function permission(): NotificationPermission | 'unsupported' {
  return typeof window.Notification === 'undefined'
    ? 'unsupported'
    : window.Notification.permission;
}

export interface Notifications {
  state: NotifyState;
  /** Turn on; asks the browser for permission the first time (only after a click). */
  enable: () => void;
  disable: () => void;
}

/**
 * Show a browser notification for live events that need a human (the shared rule is noticeFor
 * in src/notify/notice.ts; finished Runs are not announced).
 * Only events that arrive while the page is open are notified, so a reconnect or reload does
 * not repeat old ones.
 */
export function useNotifications(
  runs: RunSummary[] | undefined,
  /** The Master sends system notifications itself. */
  system: boolean,
): Notifications {
  const [pref, setPref] = useState<NotifyPref>(readPref);
  const [, setPermissionTick] = useState(0);
  const state = notifyState(permission(), pref, system);
  const stateRef = useRef(state);
  stateRef.current = state;
  const runsRef = useRef(runs);
  runsRef.current = runs;

  useStream({
    onEvent: (event) => {
      if (stateRef.current !== 'on') return;
      const goal = runsRef.current?.find((r) => r.id === event.runId)?.goal;
      const notice = noticeFor(event, goal);
      if (!notice) return;
      const n = new window.Notification(notice.title, { body: notice.body, tag: notice.tag });
      n.onclick = () => {
        window.focus();
        navigate(notice.href);
        n.close();
      };
    },
  });

  const enable = useCallback(() => {
    writePref('on');
    setPref('on');
    if (permission() === 'default') {
      void window.Notification.requestPermission().then(() => setPermissionTick((n) => n + 1));
    }
  }, []);

  const disable = useCallback(() => {
    writePref('off');
    setPref('off');
  }, []);

  return { state, enable, disable };
}
