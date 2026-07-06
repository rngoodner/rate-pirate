import { useEffect, useRef } from 'react';

/** Re-runs `refresh` when the app becomes visible again — the home-screen PWA
 *  case, where iOS resumes the page instead of reloading it and mount-time
 *  fetches never re-run — and, if `pollMs` is set, on a timer while visible.
 *  Throttled so a focus + visibilitychange pair triggers one refresh. */
export function useAutoRefresh(refresh: () => void, pollMs?: number) {
  const lastRun = useRef(Date.now());
  useEffect(() => {
    const run = () => {
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - lastRun.current < 5_000) return;
      lastRun.current = Date.now();
      refresh();
    };
    window.addEventListener('focus', run);
    document.addEventListener('visibilitychange', run);
    // Safari restores back/forward navigations from the bfcache without firing
    // focus/visibilitychange — pageshow covers it.
    window.addEventListener('pageshow', run);
    const timer = pollMs ? setInterval(run, pollMs) : undefined;
    return () => {
      window.removeEventListener('focus', run);
      document.removeEventListener('visibilitychange', run);
      window.removeEventListener('pageshow', run);
      clearInterval(timer);
    };
  }, [refresh, pollMs]);
}
