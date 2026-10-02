import { apiGet, apiPost, apiDelete, apiPut, apiPatch } from '../data/api.js';
import { createCycle, updateCycle, deleteCycle, deriveCycleStatus, getSubmissionsForCycle } from '../downtime/db.js';
import { transitionFromPhase } from '../downtime/cycle-phase.js';

const PHASE_LABELS = {
  game:       'Game',
  downtime:   'Downtime',
  processing: 'Processing',
  prep:       'Prep',
};

// The phase a row's UI reflects. CM-4a: the resolution order itself now lives
// in the pure module as transitionFromPhase, because the server enforces the
// tracker wipe off the same read and the two tiers must not answer
// differently on a legacy document (see that function's own comment). This
// wrapper keeps only the display guard it always had: anything outside the
// label map renders as "no phase" rather than leaking into labels and CSS
// class names (Codex review finding, 2026-08-10).
function uiPhase(cy) {
  const p = transitionFromPhase(cy);
  return PHASE_LABELS[p] ? p : null;
}

// A DIFFERENT question from uiPhase, and the difference matters since CM-4a:
// "what phase does this document DECLARE", not "what phase is it effectively
// in". uiPhase now resolves the legacy `status` too, so every cycle would
// answer yes to declaresPhase and deriveCurrentCycle's second (non-closed)
// branch would become unreachable. Kept explicit so the ribbon's selection
// rule is unchanged by this story.
//
// This is the ONE sanctioned second resolution order in the codebase, named
// and single-instance on purpose (pinned by the test that forbids scattered
// inline copies). It is deliberately NARROW: no `status` fallback.
function declaredPhase(cy) {
  const p = cy?.phase || cy?.game_phase || null;
  return PHASE_LABELS[p] ? p : null;
}

function declaresPhase(cy) {
  return !!declaredPhase(cy);
}

// Module-level view state so the status ribbon can refresh after any
// label / story cycle / phase / add / delete mutation without a full re-fetch.
const view = { storyCycles: [], cycles: [], sessions: [], charList: [], ribbonEl: null };

// (byIdDesc removed by CM-1: _id is creation order, not game order - proven
// wrong for ordering in this data. All cycle ordering uses game_number.)

export async function initCycleView(charList) {
  const el = document.getElementById('cycle-content');
  el.innerHTML = '<p class="placeholder">Loading…</p>';

  let storyCycles, cycles, sessions;
  try {
    // cm-2: the old chapters endpoint became /api/story_cycles. The collection
    // always held Stories (a multi-game grouping), never Chapters (which are
    // one game plus its downtime, i.e. a `chapters` document).
    [storyCycles, cycles, sessions] = await Promise.all([
      apiGet('/api/story_cycles'),
      apiGet('/api/chapters'),
      apiGet('/api/game_sessions'),
    ]);
  } catch (err) {
    el.innerHTML = `<p class="cy-error">Failed to load cycle data: ${err.message}</p>`;
    return;
  }

  view.storyCycles = storyCycles;
  view.cycles = cycles;
  view.sessions = sessions;
  view.charList = charList;

  el.innerHTML = '';
  el.appendChild(buildRibbon());
  el.appendChild(buildStoryCyclesPanel(storyCycles, cycles));
  el.appendChild(buildCyclesPanel(cycles, storyCycles, charList, sessions));
}

/** Re-fetch and rebuild the whole tab (used after add / delete). */
async function refresh() {
  await initCycleView(view.charList);
}

// ── Status ribbon ─────────────────────────────────────────────────────────────

function buildRibbon() {
  const el = document.createElement('div');
  el.className = 'cy-ribbon';
  view.ribbonEl = el;
  renderRibbon();
  return el;
}

/**
 * Current cycle: the highest-game_number cycle carrying any phase, else the
 * highest-game_number non-closed cycle. game_number is THE ordering field -
 * never _id/creation order, which is proven wrong for game order in this
 * data (2,3,1,4,5). Codex review finding, 2026-08-10: the previous
 * game-phase-first, _id-ordered logic let any stale game_phase override
 * outrank the actual current cycle in the ST's ribbon.
 */
const byGameNumberDesc = (a, b) => (b.game_number || 0) - (a.game_number || 0);
function deriveCurrentCycle() {
  const cycles = view.cycles || [];
  const phased = cycles.filter(declaresPhase).sort(byGameNumberDesc)[0];
  if (phased) return phased;
  const nonClosed = cycles.filter(c => deriveCycleStatus(c) !== 'closed').sort(byGameNumberDesc)[0];
  return nonClosed || null;
}

function renderRibbon() {
  const el = view.ribbonEl;
  if (!el) return;
  const cy = deriveCurrentCycle();

  if (!cy) {
    el.innerHTML = '<span class="cy-ribbon-empty">No active cycle.</span>';
    return;
  }

  const storyCycle = cy.story_cycle_id
    ? view.storyCycles.find(ch => String(ch._id) === String(cy.story_cycle_id))
    : null;
  const storyCycleText = storyCycle ? `${storyCycle.number} — ${storyCycle.label}` : 'No story';
  const _ribbonPhase = uiPhase(cy);
  const phaseText = _ribbonPhase ? PHASE_LABELS[_ribbonPhase] : 'No phase set';
  const phaseMod = _ribbonPhase ? ` cy-phase--${_ribbonPhase}` : ' cy-phase--none';

  el.innerHTML = `
    <div class="cy-ribbon-item">
      <span class="cy-ribbon-label">Story</span>
      <span class="cy-ribbon-val">${esc(storyCycleText)}</span>
    </div>
    <div class="cy-ribbon-item">
      <span class="cy-ribbon-label">Game Cycle</span>
      <span class="cy-ribbon-val">${esc(cy.label || String(cy._id))}</span>
    </div>
    <div class="cy-ribbon-item">
      <span class="cy-ribbon-label">Phase</span>
      <span class="cy-ribbon-chip${phaseMod}">${esc(phaseText)}</span>
    </div>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── Stories panel ──────────────────────────────────────────────────────────

/**
 * cm-3: the "Final chapter" control for one Story row.
 *
 * A pick-one, not a toggle: the ST names the specific cycle that ends this
 * Story, chosen from that Story's own member cycles. "— not closed —" clears
 * it. `story_cycles.final_chapter_id` is what `isFinalChapterOfStory`
 * (public/js/downtime/db.js) reads, and setting it is the only manual input
 * behind the ST maintenance audit panel and the player at-risk warning strip.
 *
 * Freely re-settable, including back to "— not closed —": Story length is a
 * live, revisable ST judgement call, so there is no confirmation dialog and no
 * history on the field. What IS guarded is the other direction — the server
 * refuses (409) to move or delete a cycle a Story currently names, so the
 * pointer cannot be left dangling. That refusal surfaces here, inline.
 *
 * The control disables itself for the duration of each write. Without that, a
 * rapid re-pick can resolve out of order and leave the UI disagreeing with the
 * server (review finding on cm-3's first pass, which had no in-flight guard at
 * all). The failure-path revert reads the value captured before the write, not
 * a field a concurrent request may already have mutated, and skips the revert
 * entirely if the row list was rebuilt mid-flight and this node is detached.
 */
function buildFinalChapterSelect(story, allCycles, errMsg) {
  const sel = document.createElement('select');
  sel.className = 'form-select cy-story-final';
  sel.dataset.id = String(story._id);

  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— not closed —';
  sel.appendChild(none);

  const members = (allCycles || [])
    .filter(c => c && String(c.story_cycle_id ?? '') === String(story._id))
    .sort((a, b) => (a.game_number || 0) - (b.game_number || 0));
  members.forEach(c => {
    const opt = document.createElement('option');
    opt.value = String(c._id);
    opt.textContent = c.label || (c.game_number != null ? `Game ${c.game_number}` : String(c._id));
    sel.appendChild(opt);
  });

  const current = story.final_chapter_id ? String(story.final_chapter_id) : '';
  sel.value = current;

  sel.addEventListener('change', async () => {
    const val = sel.value || null;
    const prev = story.final_chapter_id ? String(story.final_chapter_id) : '';
    errMsg.classList.remove('is-visible');
    sel.disabled = true;
    try {
      await apiPatch(`/api/story_cycles/${story._id}`, { final_chapter_id: val });
      story.final_chapter_id = val;
    } catch (err) {
      if (sel.isConnected) sel.value = prev;
      errMsg.textContent = `Save failed: ${err.message}`;
      errMsg.classList.add('is-visible');
    } finally {
      if (sel.isConnected) sel.disabled = false;
    }
  });

  return sel;
}

function buildStoryCyclesPanel(storyCycles, allCycles = view.cycles) {
  const wrap = document.createElement('div');
  wrap.className = 'cy-section';

  const header = document.createElement('div');
  header.className = 'cy-section-head';
  header.innerHTML = '<h3 class="cy-section-title">Stories</h3>';

  const addBtn = document.createElement('button');
  addBtn.className = 'btn-sm';
  addBtn.textContent = '+ New Story';
  header.appendChild(addBtn);

  const errMsg = document.createElement('p');
  errMsg.className = 'cy-error cy-error--inline';

  wrap.appendChild(header);

  const table = document.createElement('table');
  table.className = 'infl-table cy-table';
  // cm-3: "Final chapter" is the ST's one Story-level signal — it names the
  // specific cycle that ends this Story, and a Story is closed exactly when it
  // is set. It is what isFinalChapterOfStory reads, and it replaced the
  // per-chapter "Chapter Finale" checkbox that used to sit on the DT Prep
  // panel, so a Story-level decision now lives at the Story level and cannot
  // be ticked on the wrong cycle.
  table.innerHTML = `<thead><tr>
    <th class="cy-col-num">#</th>
    <th>Label</th>
    <th class="cy-col-final-chapter">Final chapter</th>
    <th class="cy-col-act"></th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  wrap.appendChild(table);
  wrap.appendChild(errMsg);

  function renderRows(list) {
    tbody.innerHTML = '';
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="cy-empty-cell">No stories yet.</td></tr>';
      return;
    }
    list.forEach(ch => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${ch.number}</td>
        <td>${esc(ch.label)}</td>
        <td class="cy-col-final-chapter"></td>
        <td><button class="btn-sm btn-danger" data-id="${ch._id}">Delete</button></td>`;
      tr.querySelector('.cy-col-final-chapter').appendChild(buildFinalChapterSelect(ch, allCycles, errMsg));

      tr.querySelector('button').addEventListener('click', async () => {
        errMsg.classList.remove('is-visible');
        try {
          await apiDelete(`/api/story_cycles/${ch._id}`);
          renderRows(list.filter(c => c._id !== ch._id));
        } catch (err) {
          // cm-2 review (P4): match 'linked to', NOT 'cycle'. Before the rename
          // the server's refusal messages were "Chapter not found" / "Invalid
          // chapter ID format", so a substring match on 'cycle' could only hit
          // the 409. The reworded messages are "Story cycle not found" /
          // "Invalid story cycle ID format", which both contain 'cycle' — so a
          // plain 404 (another ST deleted this row already) would have told the
          // ST the exact opposite of what happened. 'linked to' appears only in
          // the 409 STORY_CYCLE_IN_USE message.
          if (err.message && err.message.includes('linked to')) {
            errMsg.textContent = 'Story is linked to cycle(s). Remove the link before deleting.';
          } else {
            errMsg.textContent = `Delete failed: ${err.message}`;
          }
          errMsg.classList.add('is-visible');
        }
      });
      tbody.appendChild(tr);
    });
  }

  renderRows(storyCycles);

  // Inline new-story form
  const form = document.createElement('div');
  form.className = 'cy-inline-form';
  form.innerHTML = `
    <input id="new-sc-num" type="number" min="1" placeholder="Number" class="form-input cy-input-num">
    <input id="new-sc-label" type="text" placeholder="Label (e.g. Story Two: The Price of Power)" class="form-input cy-input-grow">
    <button class="btn-sm" id="new-sc-save">Save</button>
    <button class="btn-sm btn-muted" id="new-sc-cancel">Cancel</button>`;
  wrap.appendChild(form);

  addBtn.addEventListener('click', () => {
    form.classList.add('is-open');
    addBtn.classList.add('is-hidden');
    errMsg.classList.remove('is-visible');
    form.querySelector('#new-sc-num').value = '';
    form.querySelector('#new-sc-label').value = '';
    form.querySelector('#new-sc-num').focus();
  });

  form.querySelector('#new-sc-cancel').addEventListener('click', () => {
    form.classList.remove('is-open');
    addBtn.classList.remove('is-hidden');
  });

  form.querySelector('#new-sc-save').addEventListener('click', async () => {
    const number = parseInt(form.querySelector('#new-sc-num').value, 10);
    const label  = form.querySelector('#new-sc-label').value.trim();
    if (!number || !label) {
      errMsg.textContent = 'Both Number and Label are required.';
      errMsg.classList.add('is-visible');
      return;
    }
    errMsg.classList.remove('is-visible');
    try {
      const created = await apiPost('/api/story_cycles', { number, label });
      storyCycles = [...storyCycles, created].sort((a, b) => a.number - b.number);
      view.storyCycles = storyCycles;
      renderRows(storyCycles);
      form.classList.remove('is-open');
      addBtn.classList.remove('is-hidden');
      renderRibbon();
    } catch (err) {
      errMsg.textContent = `Save failed: ${err.message}`;
      errMsg.classList.add('is-visible');
    }
  });

  return wrap;
}

// ── Phase (read-only) ────────────────────────────────────────────────────────
//
// Story tm-admin.27.1 (2026-10-02): this tab no longer sets a Chapter's phase. TM Admin is the only
// writer of phase (PUT /api/chapters/:id/phase there), and TM Game's PUT /api/chapters/:id now
// refuses `phase`, `game_phase` and `status` with a 409. The four phase buttons, their confirm dialogs
// and the tracker-wipe warning that used to sit here are removed with it. What remains is a status
// display: glyph plus words, never colour alone. A slate reset between games is the ST's deliberate
// Reset All on the Tracker tab.
function buildPhaseCell(cy) {
  const td = document.createElement('td');
  td.className = 'cy-phase-cell';

  const phase = uiPhase(cy);
  const status = document.createElement('span');
  status.className = 'cy-phase-readonly' + (phase ? ` cy-phase-readonly--${phase}` : ' cy-phase-readonly--none');
  status.textContent = (phase ? '● ' : '○ ') + (phase ? PHASE_LABELS[phase] : 'No phase set');
  status.title = 'Phase is set in TM Admin';
  td.appendChild(status);

  const note = document.createElement('span');
  note.className = 'cy-phase-readonly-note';
  note.textContent = 'Set in TM Admin';
  td.appendChild(note);
  return td;
}

// ── Prep Access section ──────────────────────────────────────────────────────

function buildAccessSection(cy, charList) {
  const wrap = document.createElement('div');
  wrap.className = 'cy-detail-scroll';

  const activeChars = charList
    .filter(c => !c.retired)
    .sort((a, b) => (a.moniker || a.name || '').localeCompare(b.moniker || b.name || ''));

  if (!activeChars.length) {
    wrap.textContent = 'No active characters.';
    wrap.classList.add('cy-muted');
    return wrap;
  }

  const oowIds = new Set((cy.out_of_window_player_ids || []).map(String));

  activeChars.forEach(c => {
    const id = String(c._id);
    const label = document.createElement('label');
    label.className = 'cy-check-label';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = oowIds.has(id);

    const span = document.createElement('span');
    span.textContent = c.moniker || c.name || String(c._id);

    label.appendChild(cb);
    label.appendChild(span);
    wrap.appendChild(label);

    cb.addEventListener('change', async () => {
      const current = new Set((cy.out_of_window_player_ids || []).map(String));
      if (cb.checked) current.add(id); else current.delete(id);
      const updated = [...current];
      try {
        await apiPut('/api/chapters/' + cy._id, { out_of_window_player_ids: updated });
        cy.out_of_window_player_ids = updated;
      } catch (_err) {
        cb.checked = !cb.checked;
      }
    });
  });

  return wrap;
}

// ── Attendance section ───────────────────────────────────────────────────────

function buildAttendanceSection(cy, sessions) {
  const wrap = document.createElement('div');
  wrap.className = 'cy-attend';

  const selectWrap = document.createElement('div');
  selectWrap.className = 'cy-attend-head';

  const lbl = document.createElement('label');
  lbl.className = 'cy-attend-lbl';
  lbl.textContent = 'Linked Session:';

  const sel = document.createElement('select');
  sel.className = 'form-select cy-attend-select';

  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '— not linked —';
  sel.appendChild(blank);

  const sorted = [...sessions].sort((a, b) => (a.game_number ?? 999) - (b.game_number ?? 999));
  sorted.forEach(s => {
    const opt = document.createElement('option');
    opt.value = String(s._id);
    let label = s.game_number ? 'Game ' + s.game_number : '';
    if (s.title) label += (label ? ' — ' : '') + s.title;
    if (!label) label = s.session_date || String(s._id);
    opt.textContent = label;
    sel.appendChild(opt);
  });

  sel.value = cy.session_id || '';

  const errEl = document.createElement('span');
  errEl.className = 'cy-error cy-error--inline';

  selectWrap.appendChild(lbl);
  selectWrap.appendChild(sel);
  selectWrap.appendChild(errEl);
  wrap.appendChild(selectWrap);

  const tableWrap = document.createElement('div');
  wrap.appendChild(tableWrap);

  function renderTable() {
    tableWrap.innerHTML = '';
    const session = sessions.find(s => String(s._id) === sel.value);
    if (!session) return;
    const att = session.attendance || [];
    if (!att.length) {
      const msg = document.createElement('p');
      msg.className = 'cy-muted cy-attend-empty';
      msg.textContent = 'No attendance recorded for this session.';
      tableWrap.appendChild(msg);
      return;
    }

    const rows = [...att].sort((a, b) => {
      const na = (a.character_display || a.character_name || '').toLowerCase();
      const nb = (b.character_display || b.character_name || '').toLowerCase();
      return na < nb ? -1 : na > nb ? 1 : 0;
    });

    const table = document.createElement('table');
    table.className = 'infl-table cy-attend-table';
    table.innerHTML = `<thead><tr>
      <th>Character</th>
      <th class="cy-att-c">Attend</th>
      <th class="cy-att-c">Costuming</th>
      <th class="cy-att-c">DT</th>
      <th class="cy-att-c">Extra</th>
      <th class="cy-att-c">XP</th>
    </tr></thead>`;

    const tbody = document.createElement('tbody');
    let totAtt = 0, totCos = 0, totDT = 0, totExtra = 0, totXP = 0;

    rows.forEach(a => {
      const xp = (a.attended ? 1 : 0) + (a.costuming ? 1 : 0) + (a.downtime ? 1 : 0) + (a.extra || 0);
      totAtt   += a.attended  ? 1 : 0;
      totCos   += a.costuming ? 1 : 0;
      totDT    += a.downtime  ? 1 : 0;
      totExtra += (a.extra || 0);
      totXP    += xp;

      const name = a.character_display || a.character_name || a.character_id || '?';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${esc(name)}</td>
        <td class="cy-att-c">${a.attended  ? '●' : '○'}</td>
        <td class="cy-att-c">${a.costuming ? '●' : '○'}</td>
        <td class="cy-att-c">${a.downtime  ? '●' : '○'}</td>
        <td class="cy-att-c">${a.extra || 0}</td>
        <td class="cy-att-c cy-att-xp">${xp}</td>`;
      tbody.appendChild(tr);
    });

    const totTr = document.createElement('tr');
    totTr.className = 'cy-att-total';
    totTr.innerHTML = `
      <td class="cy-muted">Total (${rows.length})</td>
      <td class="cy-att-c">${totAtt}</td>
      <td class="cy-att-c">${totCos}</td>
      <td class="cy-att-c">${totDT}</td>
      <td class="cy-att-c">${totExtra}</td>
      <td class="cy-att-c">${totXP}</td>`;
    tbody.appendChild(totTr);

    table.appendChild(tbody);
    tableWrap.appendChild(table);
  }

  renderTable();

  sel.addEventListener('change', async () => {
    errEl.classList.remove('is-visible');
    const newId = sel.value || null;
    try {
      await apiPut('/api/chapters/' + cy._id, { session_id: newId });
      cy.session_id = newId;
      renderTable();
    } catch (err) {
      sel.value = cy.session_id || '';
      errEl.textContent = 'Link failed: ' + err.message;
      errEl.classList.add('is-visible');
    }
  });

  return wrap;
}

// ── Game Cycles panel ───────────────────────────────────────────────────────

// Build a story cycle <select>. Options-only; no persistence handler — used
// for the add-cycle form (which has no cycle to write to yet).
function buildStoryCyclePicker(storyCycles, selectedId = '') {
  const sel = document.createElement('select');
  sel.className = 'form-select cy-story-cycle-select';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— none —';
  sel.appendChild(none);
  [...storyCycles].sort((a, b) => a.number - b.number).forEach(ch => {
    const opt = document.createElement('option');
    opt.value = String(ch._id);
    opt.textContent = `${ch.number} — ${ch.label}`;
    sel.appendChild(opt);
  });
  sel.value = selectedId ? String(selectedId) : '';
  return sel;
}

// Row-level story cycle select: persists story_cycle_id to an existing cycle
// on change.
//
// cm-3 AC10: this write can now be REFUSED. The server returns 409
// CYCLE_IS_STORY_FINALE when the cycle being moved is the one a Story names as
// its `final_chapter_id` — moving it would leave that pointer dangling and the
// finale would silently vanish. A bare value-revert (all this handler used to
// do) would have looked like the click never registered, so the refusal is
// surfaced next to the control.
function buildStoryCycleSelect(cy, storyCycles) {
  const sel = buildStoryCyclePicker(storyCycles, cy.story_cycle_id);
  const errEl = document.createElement('span');
  errEl.className = 'cy-error cy-error--inline cy-story-cycle-err';
  sel.addEventListener('change', async () => {
    const val = sel.value || null;
    errEl.classList.remove('is-visible');
    try {
      await updateCycle(cy._id, { story_cycle_id: val });
      cy.story_cycle_id = val;
      renderRibbon();
    } catch (err) {
      sel.value = cy.story_cycle_id ? String(cy.story_cycle_id) : '';
      errEl.textContent = err.message;
      errEl.classList.add('is-visible');
    }
  });
  const wrap = document.createDocumentFragment();
  wrap.appendChild(sel);
  wrap.appendChild(errEl);
  return wrap;
}

function buildLabelCell(cy) {
  const td = document.createElement('td');
  td.className = 'cy-label-cell';

  function renderView() {
    td.innerHTML = '';
    const inner = document.createElement('div');
    inner.className = 'cy-label-inner';
    const span = document.createElement('span');
    span.className = 'cy-label-text';
    span.textContent = cy.label || String(cy._id);
    const editBtn = document.createElement('button');
    editBtn.className = 'cy-icon-btn';
    editBtn.title = 'Edit label';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', renderEdit);
    inner.appendChild(span);
    inner.appendChild(editBtn);
    td.appendChild(inner);
    // #1002: the cycle label alone invites the wrong flip (downtimes are
    // collected AFTER game N and consumed AT session N+1 — the humanly
    // obvious "Game N feeds Game N" reading is backwards). Derived from
    // game_number, never stored, shown only when it's known.
    if (cy.game_number != null) {
      const span2 = document.createElement('div');
      span2.className = 'cy-label-span';
      span2.textContent = `DT after Game ${cy.game_number} · feeds Game ${cy.game_number + 1}`;
      td.appendChild(span2);
    }
  }

  function renderEdit() {
    td.innerHTML = '';
    const inner = document.createElement('div');
    inner.className = 'cy-label-inner';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-input cy-label-input';
    input.value = cy.label || '';
    const save = document.createElement('button');
    save.className = 'btn-sm';
    save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.className = 'btn-sm btn-muted';
    cancel.textContent = 'Cancel';

    async function doSave() {
      const newLabel = input.value.trim();
      if (!newLabel) { input.focus(); return; }
      try {
        await updateCycle(cy._id, { label: newLabel });
        cy.label = newLabel;
        renderView();
        renderRibbon();
      } catch (_err) {
        input.classList.add('is-error');
      }
    }
    save.addEventListener('click', doSave);
    cancel.addEventListener('click', renderView);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') doSave();
      else if (e.key === 'Escape') renderView();
    });

    inner.appendChild(input);
    inner.appendChild(save);
    inner.appendChild(cancel);
    td.appendChild(inner);
    input.focus();
    input.select();
  }

  renderView();
  return td;
}

function buildCyclesPanel(cycles, storyCycles, charList = [], sessions = []) {
  const sorted = [...cycles].sort((a, b) => (a.game_number ?? 0) - (b.game_number ?? 0));

  const wrap = document.createElement('div');
  wrap.className = 'cy-section';

  const header = document.createElement('div');
  header.className = 'cy-section-head';
  header.innerHTML = '<h3 class="cy-section-title">Game Cycles</h3>';

  const addBtn = document.createElement('button');
  addBtn.className = 'btn-sm';
  addBtn.textContent = '+ New Cycle';
  header.appendChild(addBtn);
  wrap.appendChild(header);

  const errMsg = document.createElement('p');
  errMsg.className = 'cy-error cy-error--inline';

  // Inline add-cycle form
  const addForm = document.createElement('div');
  addForm.className = 'cy-inline-form';
  const nextGame = (sorted.reduce((mx, c) => Math.max(mx, c.game_number ?? 0), 0) || 0) + 1;
  addForm.innerHTML = `
    <input id="new-cy-num" type="number" min="1" placeholder="Game #" value="${nextGame}" class="form-input cy-input-num">
    <input id="new-cy-label" type="text" placeholder="Label (e.g. Downtime 5)" class="form-input cy-input-grow">
    <button class="btn-sm" id="new-cy-save">Save</button>
    <button class="btn-sm btn-muted" id="new-cy-cancel">Cancel</button>`;
  const storyCyclePick = buildStoryCyclePicker(storyCycles);
  storyCyclePick.id = 'new-cy-story-cycle';
  addForm.insertBefore(storyCyclePick, addForm.querySelector('#new-cy-save'));
  wrap.appendChild(addForm);

  addBtn.addEventListener('click', () => {
    addForm.classList.add('is-open');
    addBtn.classList.add('is-hidden');
    errMsg.classList.remove('is-visible');
    addForm.querySelector('#new-cy-label').value = `Downtime ${nextGame}`;
    addForm.querySelector('#new-cy-label').focus();
  });
  addForm.querySelector('#new-cy-cancel').addEventListener('click', () => {
    addForm.classList.remove('is-open');
    addBtn.classList.remove('is-hidden');
  });
  addForm.querySelector('#new-cy-save').addEventListener('click', async () => {
    const num = parseInt(addForm.querySelector('#new-cy-num').value, 10);
    const label = addForm.querySelector('#new-cy-label').value.trim();
    const storyCycleId = addForm.querySelector('#new-cy-story-cycle').value || null;
    if (!num || !label) {
      errMsg.textContent = 'Game number and label are required.';
      errMsg.classList.add('is-visible');
      return;
    }
    errMsg.classList.remove('is-visible');
    try {
      await createCycle(num, { label, storyCycleId });
      await refresh();
    } catch (err) {
      errMsg.textContent = `Create failed: ${err.message}`;
      errMsg.classList.add('is-visible');
    }
  });

  if (!sorted.length) {
    const empty = document.createElement('p');
    empty.className = 'cy-muted';
    empty.textContent = 'No downtime cycles found.';
    wrap.appendChild(errMsg);
    wrap.appendChild(empty);
    return wrap;
  }

  const table = document.createElement('table');
  table.className = 'infl-table cy-table';
  table.innerHTML = `<thead><tr>
    <th>Label</th>
    <th class="cy-col-phase">Phase</th>
    <th class="cy-col-story-cycle">Story</th>
    <th class="cy-col-prep">Prep Access</th>
    <th class="cy-col-pub">Publish</th>
    <th class="cy-col-att">Attendance</th>
    <th class="cy-col-del"></th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');

  sorted.forEach(cy => {
    const tr = document.createElement('tr');

    tr.appendChild(buildLabelCell(cy));
    tr.appendChild(buildPhaseCell(cy));

    const tdStoryCycle = document.createElement('td');
    tdStoryCycle.appendChild(buildStoryCycleSelect(cy, storyCycles));
    tr.appendChild(tdStoryCycle);

    // Prep Access toggle
    const tdAccess = document.createElement('td');
    const accessBtn = document.createElement('button');
    accessBtn.className = 'btn-sm';
    accessBtn.textContent = 'Prep Access';
    tdAccess.appendChild(accessBtn);
    tr.appendChild(tdAccess);

    const detailTr = document.createElement('tr');
    detailTr.className = 'cy-detail-row is-hidden';
    const detailTd = document.createElement('td');
    detailTd.colSpan = 7;
    detailTd.className = 'cy-detail-cell';
    detailTd.appendChild(buildAccessSection(cy, charList));
    detailTr.appendChild(detailTd);

    accessBtn.addEventListener('click', () => {
      const open = !detailTr.classList.contains('is-hidden');
      detailTr.classList.toggle('is-hidden', open);
      accessBtn.classList.toggle('is-active', !open);
    });

    // Publish Reports button
    const tdPublish = document.createElement('td');
    const publishBtn = document.createElement('button');
    publishBtn.className = 'btn-sm';
    publishBtn.textContent = 'Publish Reports';
    const publishResult = document.createElement('span');
    publishResult.className = 'cy-publish-result';
    tdPublish.appendChild(publishBtn);
    tdPublish.appendChild(publishResult);
    tr.appendChild(tdPublish);

    publishBtn.addEventListener('click', async () => {
      publishBtn.disabled = true;
      publishResult.className = 'cy-publish-result';
      publishResult.textContent = 'Publishing…';
      try {
        const result = await apiPost('/api/chapters/' + cy._id + '/publish', {});
        if (result.published === 0) {
          publishResult.textContent = 'No compiled reports found.';
        } else {
          publishResult.classList.add('is-ok');
          publishResult.textContent = result.published + ' report' + (result.published === 1 ? '' : 's') + ' published.';
        }
      } catch (err) {
        publishResult.classList.add('is-error');
        publishResult.textContent = 'Publish failed: ' + err.message;
      } finally {
        publishBtn.disabled = false;
      }
    });

    // Attendance toggle
    const tdAtt = document.createElement('td');
    const attBtn = document.createElement('button');
    attBtn.className = 'btn-sm';
    attBtn.textContent = 'Attendance';
    tdAtt.appendChild(attBtn);
    tr.appendChild(tdAtt);

    const attendTr = document.createElement('tr');
    attendTr.className = 'cy-detail-row is-hidden';
    const attendTd = document.createElement('td');
    attendTd.colSpan = 7;
    attendTd.className = 'cy-detail-cell';
    attendTd.appendChild(buildAttendanceSection(cy, sessions));
    attendTr.appendChild(attendTd);

    attBtn.addEventListener('click', () => {
      const open = !attendTr.classList.contains('is-hidden');
      attendTr.classList.toggle('is-hidden', open);
      attBtn.classList.toggle('is-active', !open);
    });

    // Delete cycle
    const tdDel = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-sm btn-danger';
    delBtn.textContent = 'Delete';
    tdDel.appendChild(delBtn);
    tr.appendChild(tdDel);

    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete cycle "${cy.label || cy._id}"? This cannot be undone.`)) return;
      errMsg.classList.remove('is-visible');
      delBtn.disabled = true;
      try {
        await deleteCycle(cy._id);
        await refresh();
      } catch (err) {
        delBtn.disabled = false;
        // 409 CYCLE_HAS_SUBMISSIONS surfaces here with the server message.
        errMsg.textContent = err.message || 'Delete failed.';
        errMsg.classList.add('is-visible');
      }
    });

    tbody.appendChild(tr);
    tbody.appendChild(detailTr);
    tbody.appendChild(attendTr);
  });

  table.appendChild(tbody);
  wrap.appendChild(errMsg);
  wrap.appendChild(table);
  return wrap;
}
