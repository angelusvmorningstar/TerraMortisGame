/* crd.2 — the destination the pending-challenge queue routes into.
 *
 * This is DELIBERATELY a placeholder, and says so on screen. crd.2's scope is
 * the queue list and its routing contract; the real resolution screen (the
 * Mental/Social/Physical aspect control, the Willpower spend, the merit chips,
 * and the hand-off to the dice roller) is crd.3b's whole job, and it depends on
 * a server-side endpoint (crd.3a) that does not exist yet.
 *
 * What matters here is that the DOOR is real and already works. This module is
 * mounted by app.js's goTab() with a context payload carrying the specific
 * challenge's own `_id`, so crd.3b builds the room behind an already-hung door
 * rather than having to invent the door as well. Its entry contract is:
 *
 *     goTab('contested-resolve', { challengeId })   ->   initContestedResolve(el, ctx)
 *
 * Do not grow pool-building logic in here. When crd.3b lands it replaces this
 * file's body, not its signature.
 */

import { esc, redactCharName } from '../data/helpers.js';
import { ROLL_LABELS, getPendingChallenge } from './pending-queue.js';

let _rootEl = null;

export function initContestedResolve(rootEl, ctx) {
  if (!rootEl) return;

  const challengeId = ctx?.challengeId ? String(ctx.challengeId) : '';
  const challenge = challengeId ? getPendingChallenge(challengeId) : null;

  rootEl.innerHTML = _html(challengeId, challenge);

  if (rootEl !== _rootEl) {
    _rootEl = rootEl;
    rootEl.addEventListener('click', (e) => {
      if (!e.target.closest('[data-cr-back]')) return;
      if (typeof window !== 'undefined' && typeof window.goTab === 'function') {
        window.goTab('contested-queue');
      }
    });
  }
}

function _html(challengeId, challenge) {
  const detail = challenge
    ? `
        <div class="ch-pools">
          <div class="ch-pool-row">
            <span class="ch-pool-lbl">Challenger</span>
            <span class="ch-pool-val">${esc(redactCharName(challenge.challenger_character_name || 'Someone'))}</span>
          </div>
          <div class="ch-pool-row">
            <span class="ch-pool-lbl">Contest</span>
            <span class="ch-pool-val">${esc(ROLL_LABELS[challenge.roll_type] || challenge.roll_type || 'Contested Roll')}</span>
          </div>
          <div class="ch-pool-row">
            <span class="ch-pool-lbl">Defending as</span>
            <span class="ch-pool-val">${esc(redactCharName(challenge.target_character_name || 'your character'))}</span>
          </div>
        </div>`
    : '';

  const idLine = challengeId
    ? `<p class="derived-note cq-ref">Challenge reference: ${esc(challengeId)}</p>`
    : `<p class="derived-note cq-ref">No challenge was selected. Open one from the Challenges list.</p>`;

  return `
    <div class="stm-audit-root">
      <header class="stm-audit-head">
        <h2>Resolve Challenge</h2>
        <p class="stm-audit-sub">Building your own dice pool is coming soon.</p>
      </header>
      <div class="cq-resolve-body">
        <p class="ch-desc">
          You will be able to choose how you resist, spend Willpower, and apply any
          merits that qualify, before the dice are rolled. That screen is still
          being built, so nothing here changes your challenge yet.
        </p>
        ${detail}
        ${idLine}
        <div class="ch-modal-actions cq-actions">
          <button type="button" class="ch-btn ch-btn-decline" data-cr-back>Back to Challenges</button>
        </div>
      </div>
    </div>
  `;
}
