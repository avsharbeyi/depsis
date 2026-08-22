import type { OpenApi } from '@depsis/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from './api.js';

/** Straight from the contract, so a field renamed in the YAML breaks this file. */
export type Prefs = OpenApi.components['schemas']['Preferences'];

/**
 * What the desktop looks like before the server has answered, and what it falls back to when the
 * document has never been written.
 *
 * Every field is optional in the contract — `GET /me/preferences` returns `{}` for an account that
 * has never saved anything — so something has to decide what "no background chosen" means. Deciding
 * it here, once, is why no screen has to write `prefs.background?.kind ?? 'sky'` for itself.
 */
const DEFAULTS: Prefs = { background: { kind: 'sky' }, sound: false, shortcuts: [] };

/**
 * The user's interface preferences, held server-side.
 *
 * Server-side rather than in `localStorage` because a preference in a browser belongs to that
 * browser: the same person opening the appliance from a phone would find someone else's desk.
 */
/** How long to wait before asking again after a read that did not answer. */
const RETRY_MS = 15_000;

export function usePrefs(): {
  prefs: Prefs;
  save: (next: Prefs) => Promise<boolean>;
  loaded: boolean;
} {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  /**
   * The same flag, readable from `save` without making it a dependency.
   *
   * `save` is handed to `Shortcuts` and `Background`, both of which key effects on its identity; a
   * `save` that is rebuilt the moment the first read lands would re-run those for a reason that has
   * nothing to do with what they are watching.
   */
  const known = useRef(false);

  useEffect(() => {
    let alive = true;
    let timer = 0;

    /**
     * A failed read must NOT settle into the defaults.
     *
     * Every writer here PUTs the whole document — the shortcut field, the wallpaper picker and the
     * sound switch all send `{...prefs, one field}` — so a placebo `{background: sky, shortcuts: []}`
     * standing in for an unread document turns the very next click into a write that erases the
     * desk the user actually arranged. `loaded` therefore stays false while the answer is unknown,
     * the screens that write are not rendered until it is true, and the read keeps retrying because
     * "still trying" is the only thing that flag can honestly mean.
     */
    const read = async (): Promise<void> => {
      const { data } = await api.GET('/me/preferences', {});
      if (!alive) return;
      if (data === undefined) {
        timer = window.setTimeout(() => void read(), RETRY_MS);
        return;
      }
      setPrefs({ ...DEFAULTS, ...data });
      known.current = true;
      setLoaded(true);
    };

    void read();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  /**
   * Writes the whole document and reports whether the server took it.
   *
   * The local copy is replaced with what came back, never with what was sent. The schema is
   * deliberately narrow and validated — `solid` without a `preset` is a 422 — and applying a
   * rejected preference locally would tell the user it was saved when the next reload will show
   * that it was not. On a refusal the caller gets `false` and the old state stands.
   */
  const save = useCallback(async (next: Prefs): Promise<boolean> => {
    // Refused rather than sent. The callers are already gated on `loaded`, but this is the last
    // gate before the request that could overwrite somebody's desk with a placeholder, and it is
    // the one that cannot be forgotten by a screen added later.
    if (!known.current) return false;
    try {
      const { data } = await api.PUT('/me/preferences', { body: next });
      if (data === undefined) return false;
      setPrefs({ ...DEFAULTS, ...data });
      return true;
    } catch {
      return false;
    }
  }, []);

  return { prefs, save, loaded };
}
