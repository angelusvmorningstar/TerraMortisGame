/**
 * Epic 12, Story 12.1 - the TM Game half: a client module that reads one
 * character's feeding sub-document from TM Story's own API.
 *
 * AC 3 (new client module, cross-origin, same Discord bearer token, base
 * origin held in a config constant rather than inline), plus the degrade-
 * safely requirement that comes with AC 4's real production CORS gap.
 *
 * `fetch` is stubbed rather than hit for real: the point under test is the
 * URL, the headers and the failure handling, not TM Story's route (that has
 * its own suite, in its own repo).
 *
 * No DOM here (no jsdom in this runner - see bl5-lineage-lock-client.test.js
 * for the same note), which is fine: this module touches only `location`,
 * `localStorage` and `fetch`, all stubbed below.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './helpers/strip-comments.js';

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
  clear: () => store.clear(),
};
globalThis.location = { hostname: 'terramortisgame.netlify.app', pathname: '/index.html' };

const {
  fetchStoryFeeding, storyApiBase, storyFeedingPath, storyFeedingUrl,
  STORY_API_PROD, STORY_API_LOCAL, STORY_API_OVERRIDE_KEY,
} = await import('../../public/js/data/story-feeding.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const CHAR = '69d73ea49162ece35897a48c';   // Jack Fallow, per the story's grounding
const CYCLE = '69d0a3c5052b57f6be774e69';

function okResponse(body, status = 200) {
  return { ok: true, status, json: async () => body };
}
function errResponse(status) {
  return { ok: false, status, json: async () => ({ error: 'nope' }) };
}

beforeEach(() => {
  store.clear();
  store.set('tm_auth_token', 'discord-token-abc');
  globalThis.location = { hostname: 'terramortisgame.netlify.app', pathname: '/index.html' };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ═════════════════════════════════════════════════════════════════════════════
//  Base origin (AC 3: a config constant, resolved per call, not inline)
// ═════════════════════════════════════════════════════════════════════════════

describe('storyApiBase', () => {
  it('is TM Story\'s real deployed API host in production', () => {
    expect(STORY_API_PROD).toBe('https://tm-story-api.onrender.com');
    expect(storyApiBase()).toBe('https://tm-story-api.onrender.com');
  });

  it('points at a local port when served from localhost', () => {
    globalThis.location = { hostname: 'localhost', pathname: '/index.html' };
    expect(storyApiBase()).toBe(STORY_API_LOCAL);
  });

  it('honours a bare-origin localStorage override on localhost, trailing slashes trimmed', () => {
    globalThis.location = { hostname: 'localhost', pathname: '/index.html' };
    store.set(STORY_API_OVERRIDE_KEY, 'http://localhost:3100/');
    expect(storyApiBase()).toBe('http://localhost:3100');
  });

  it('is cross-origin, not same-origin like data/api.js', () => {
    // data/api.js resolves to '' in production (same-origin via the Netlify
    // proxy). This module must not, or the whole story is pointless.
    expect(storyApiBase()).not.toBe('');
  });

  // External review (Codex, 2026-09-10, High): the override used to be honoured on ANY host,
  // including production - since it carries the Discord bearer token with it, that let anything
  // able to write this one localStorage key redirect the token to an attacker-controlled origin.
  // Reproduced live against a production hostname before the fix.
  describe('override safety (Codex High finding)', () => {
    it('is IGNORED on a production hostname, even a well-formed one', () => {
      globalThis.location = { hostname: 'terramortisgame.netlify.app', pathname: '/index.html' };
      store.set(STORY_API_OVERRIDE_KEY, 'https://attacker.example');
      expect(storyApiBase()).toBe(STORY_API_PROD);
    });

    it('rejects an override carrying a path, query, fragment or credentials, even on localhost', () => {
      globalThis.location = { hostname: 'localhost', pathname: '/index.html' };
      for (const bad of [
        'https://attacker.example/collect',
        'http://localhost:3100/x',
        'http://localhost:3100?x=1',
        'http://localhost:3100#x',
        'http://user:pass@localhost:3100',
        'javascript:alert(1)',
        'not a url',
      ]) {
        store.set(STORY_API_OVERRIDE_KEY, bad);
        expect(storyApiBase()).toBe(STORY_API_LOCAL);
      }
    });

    it('falls back to the local default when localStorage itself throws on localhost', () => {
      globalThis.location = { hostname: 'localhost', pathname: '/index.html' };
      const real = globalThis.localStorage;
      globalThis.localStorage = { getItem: () => { throw new DOMException('denied', 'SecurityError'); } };
      try {
        expect(storyApiBase()).toBe(STORY_API_LOCAL);
      } finally {
        globalThis.localStorage = real;
      }
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The URL contract (fixed by TM Story's own router mount)
// ═════════════════════════════════════════════════════════════════════════════

describe('storyFeedingPath / storyFeedingUrl', () => {
  it('builds the agreed route shape', () => {
    expect(storyFeedingPath(CHAR, CYCLE))
      .toBe(`/api/wiki/v1/downtime/submissions/${CHAR}/${CYCLE}/feeding`);
  });

  it('encodes its ids', () => {
    expect(storyFeedingPath('a/b', 'c d')).toBe('/api/wiki/v1/downtime/submissions/a%2Fb/c%20d/feeding');
  });

  it('prefixes the resolved base origin', () => {
    expect(storyFeedingUrl(CHAR, CYCLE))
      .toBe(`https://tm-story-api.onrender.com/api/wiki/v1/downtime/submissions/${CHAR}/${CYCLE}/feeding`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Success path
// ═════════════════════════════════════════════════════════════════════════════

describe('fetchStoryFeeding - success', () => {
  it('calls the right URL with the token this app already holds', async () => {
    const f = vi.fn(async () => okResponse({ feeding: {}, lifecycle_state: 'submitted', status: 'final' }));
    vi.stubGlobal('fetch', f);

    await fetchStoryFeeding(CHAR, CYCLE);

    expect(f).toHaveBeenCalledTimes(1);
    const [url, opts] = f.mock.calls[0];
    expect(url).toBe(`https://tm-story-api.onrender.com/api/wiki/v1/downtime/submissions/${CHAR}/${CYCLE}/feeding`);
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe('Bearer discord-token-abc');
  });

  it('returns TM Story\'s body verbatim, unreshaped', async () => {
    const body = {
      feeding: {
        method: 'Hunting',
        poolAttr: 'Manipulation',
        rollResult: { pool: 7, dice: [8, 3, 10, 2, 6, 9, 1], successes: 3, exceptional: false },
        vesselVitae: [2, 1],
        aggHealed: 0,
        poolLocked: true,
      },
      lifecycle_state: 'submitted',
      status: 'final',
    };
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(body)));

    const res = await fetchStoryFeeding(CHAR, CYCLE);

    expect(res.ok).toBe(true);
    expect(res.httpStatus).toBe(200);
    expect(res.data).toEqual(body);
    expect(res.data.feeding.rollResult.successes).toBe(3);
  });

  it('passes through a historical submission with no feeding data at all', async () => {
    // Story 12.5's job, not this module's: return what is really there.
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ feeding: null, lifecycle_state: 'draft', status: null })));

    const res = await fetchStoryFeeding(CHAR, CYCLE);

    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ feeding: null, lifecycle_state: 'draft', status: null });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Failure paths - all degrade, none throw (AC 4's CORS gap is real today)
// ═════════════════════════════════════════════════════════════════════════════

describe('fetchStoryFeeding - degrades safely', () => {
  it('treats a thrown fetch (offline, DNS, blocked CORS) as no data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));

    const res = await fetchStoryFeeding(CHAR, CYCLE);

    expect(res).toMatchObject({ ok: false, data: null, reason: 'network', httpStatus: 0 });
    expect(res.detail).toBe('Failed to fetch');
  });

  it('maps 404 to not-found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errResponse(404)));
    const res = await fetchStoryFeeding(CHAR, CYCLE);
    expect(res).toMatchObject({ ok: false, data: null, reason: 'not-found', httpStatus: 404 });
  });

  it('maps 401 and 403 to unauthorised', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errResponse(401)));
    expect((await fetchStoryFeeding(CHAR, CYCLE)).reason).toBe('unauthorised');
    vi.stubGlobal('fetch', vi.fn(async () => errResponse(403)));
    expect((await fetchStoryFeeding(CHAR, CYCLE)).reason).toBe('unauthorised');
  });

  it('maps any other non-2xx to http', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errResponse(500)));
    const res = await fetchStoryFeeding(CHAR, CYCLE);
    expect(res).toMatchObject({ ok: false, reason: 'http', httpStatus: 500 });
  });

  it('survives a 2xx whose body will not parse', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); },
    })));
    const res = await fetchStoryFeeding(CHAR, CYCLE);
    expect(res).toMatchObject({ ok: false, data: null, reason: 'bad-json', httpStatus: 200 });
  });

  it('makes no request at all without a token', async () => {
    store.delete('tm_auth_token');
    const f = vi.fn();
    vi.stubGlobal('fetch', f);

    const res = await fetchStoryFeeding(CHAR, CYCLE);

    expect(res).toMatchObject({ ok: false, reason: 'no-token' });
    expect(f).not.toHaveBeenCalled();
  });

  it('makes no request at all without both ids', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);

    expect((await fetchStoryFeeding('', CYCLE)).reason).toBe('bad-args');
    expect((await fetchStoryFeeding(CHAR, null)).reason).toBe('bad-args');
    expect(f).not.toHaveBeenCalled();
  });

  // External review (Codex, 2026-09-10, Low): the token read used to sit outside any try/catch,
  // so a throwing localStorage accessor (sandboxed/opaque origin, blocked storage) turned this
  // into a rejected promise instead of the documented never-throws {ok:false} result. Reproduced
  // live with a throwing getter before the fix.
  it('degrades to no-token, never rejects, when localStorage itself throws', async () => {
    const real = globalThis.localStorage;
    globalThis.localStorage = { getItem: () => { throw new DOMException('denied', 'SecurityError'); } };
    const f = vi.fn();
    vi.stubGlobal('fetch', f);

    try {
      await expect(fetchStoryFeeding(CHAR, CYCLE)).resolves.toMatchObject({ ok: false, reason: 'no-token' });
      expect(f).not.toHaveBeenCalled();
    } finally {
      globalThis.localStorage = real;
    }
  });

  it('handles a 204 with no body as ok with null data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 204, json: async () => { throw new Error('no body'); } })));
    const res = await fetchStoryFeeding(CHAR, CYCLE);
    expect(res).toEqual({ ok: true, data: null, httpStatus: 204 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Consumer - Story 12.2 wired this client into the Feeding tab
// ═════════════════════════════════════════════════════════════════════════════

describe('consumer', () => {
  // Until Story 12.2 landed this asserted the OPPOSITE: that feeding-tab.js was
  // deliberately untouched ("Story 12.2 does that"). 12.2 has now done it, so
  // the same guard is inverted rather than deleted - this module having no
  // consumer at all would mean the read path is dead code again.
  // Behaviour-level coverage of what the tab does with the data is in
  // epic12.2-feeding-tab-form-roll.test.js, which executes the tab rather than
  // reading it.
  it('is wired into feeding-tab.js by Story 12.2', () => {
    const tab = stripComments(read('public/js/tabs/feeding-tab.js'));
    expect(tab).toMatch(/from '\.\.\/data\/story-feeding\.js'/);
    expect(tab).toMatch(/fetchStoryFeeding\(/);
  });
});
