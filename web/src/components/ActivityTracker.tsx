import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { getToken } from '../api/client.js';
import { useAuth } from '../state/AuthContext.js';

/**
 * Tells the panel which page this tab is on, so admins can see who is online and what they're
 * doing (Activity page). Pings on every navigation, when the tab is hidden or shown, and every
 * 30 seconds while open; says goodbye when the tab closes. Renders nothing.
 */

const HEARTBEAT_MS = 30_000;
const TAB_KEY = 'outpost_tab_id';

/** One id per browser tab (sessionStorage is per tab), so two open tabs show up separately. */
function tabId(): string {
  try {
    let id = sessionStorage.getItem(TAB_KEY);
    if (!id) {
      id = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
      sessionStorage.setItem(TAB_KEY, id);
    }
    return id;
  } catch {
    return 'default';
  }
}

/** Plain fetch: presence pings shouldn't show the activity bar or bounce to the login page. */
function send(endpoint: 'presence' | 'leave', body: Record<string, unknown>) {
  const token = getToken();
  if (!token) return;
  void fetch(`/api/activity/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
}

const UNTRACKED = /^\/(login|setup|status)(\/|$)/;

export function ActivityTracker() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const path = useRef(pathname);
  path.current = pathname;
  const signedIn = !!user;

  // Navigation.
  useEffect(() => {
    if (signedIn && !UNTRACKED.test(pathname)) send('presence', { tabId: tabId(), path: pathname, visible: !document.hidden });
  }, [signedIn, pathname]);

  // Heartbeat, visibility changes, and closing the tab.
  useEffect(() => {
    if (!signedIn) return;
    const ping = () => {
      if (!UNTRACKED.test(path.current)) send('presence', { tabId: tabId(), path: path.current, visible: !document.hidden });
    };
    const leave = () => send('leave', { tabId: tabId() });
    const timer = window.setInterval(ping, HEARTBEAT_MS);
    document.addEventListener('visibilitychange', ping);
    window.addEventListener('pagehide', leave);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', ping);
      window.removeEventListener('pagehide', leave);
    };
  }, [signedIn]);

  return null;
}
