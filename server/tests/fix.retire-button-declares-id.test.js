/**
 * Retire button: toggleRetire must PUT to the character's own id.
 *
 * #943 removed `const { _id, ...body } = c` from toggleRetire but left `'/api/characters/' + _id` behind,
 * so the function threw a ReferenceError (caught, then alerted as "Retire failed") on every click. The
 * static mirror-tests in fix.943 only grep the source, so they could not see it. This one RUNS the real
 * toggleRetire, sliced out of admin.js, against stubs.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminSrc = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public/js/admin.js'), 'utf8');

function sliceFunction(src, header) {
  const start = src.indexOf(header);
  if (start === -1) throw new Error(`${header} not found in admin.js`);
  let depth = 0, inBody = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') { depth++; inBody = true; }
    else if (src[i] === '}') depth--;
    if (inBody && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced braces');
}

const toggleRetireSrc = sliceFunction(adminSrc, 'async function toggleRetire');

function build({ put, retired = false, confirmAnswer = true }) {
  const calls = { put: [], alerts: [], renders: 0, btn: { textContent: '' } };
  const c = { _id: 'abc123', name: 'Test Person', retired };
  const env = {
    editorState: { editIdx: 0 },
    chars: [c],
    confirm: () => confirmAnswer,
    cardName: (x) => x.name,
    document: { getElementById: () => calls.btn },
    apiPut: async (url, body) => { calls.put.push([url, body]); return put ? put(url, body) : { retired: body.retired }; },
    renderCharGrid: () => { calls.renders++; },
    alert: (m) => { calls.alerts.push(m); },
    console: { error() {}, warn() {}, log() {} },
  };
  const fn = new Function(...Object.keys(env), `${toggleRetireSrc}\nreturn toggleRetire;`)(...Object.values(env));
  return { fn, calls, c };
}

describe('toggleRetire runs end to end', () => {
  it('retires: PUTs { retired: true } to the character id, no alert, button flips', async () => {
    const { fn, calls, c } = build({ retired: false });
    await fn();
    expect(calls.alerts).toEqual([]);
    expect(calls.put).toEqual([['/api/characters/abc123', { retired: true }]]);
    expect(c.retired).toBe(true);
    expect(calls.btn.textContent).toBe('Unretire');
    expect(calls.renders).toBe(1);
  });

  it('unretires: PUTs { retired: false } to the character id', async () => {
    const { fn, calls, c } = build({ retired: true });
    await fn();
    expect(calls.alerts).toEqual([]);
    expect(calls.put).toEqual([['/api/characters/abc123', { retired: false }]]);
    expect(c.retired).toBe(false);
    expect(calls.btn.textContent).toBe('Retire');
  });

  it('a declined confirm sends nothing', async () => {
    const { fn, calls } = build({ confirmAnswer: false });
    await fn();
    expect(calls.put).toEqual([]);
    expect(calls.alerts).toEqual([]);
  });

  it('a failed PUT alerts, leaves the character as it was and restores the button', async () => {
    const { fn, calls, c } = build({ retired: false, put: async () => { throw new Error('boom'); } });
    await fn();
    expect(calls.alerts).toEqual(['Retire failed: boom']);
    expect(c.retired).toBe(false);
    expect(calls.btn.textContent).toBe('Retire');
  });
});
