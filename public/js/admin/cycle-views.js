import { apiGet, apiPost, apiDelete, apiPut } from '../data/api.js';
import { createCycle, updateCycle, deleteCycle, deriveCycleStatus, getSubmissionsForCycle, zeroSubmissionFlipWarning, zeroSubmissionFlipMessage, cycleSpanLabel, cycleFeedsLabel } from '../downtime/db.js';

const PHASE_LABELS = {
  game:       'Game',
  downtime:   'Downtime',
  processing: 'Processing',
};

const PHASES = ['game', 'downtime', 'processing'];

// Module-level view state so the status ribbon can refresh after any
// label / chapter / phase / add / delete mutation without a full re-fetch.
const view = { chapters: [], cycles: [], sessions: [], charList: [], ribbonEl: null };

// _id is a creation-order proxy (cycle docs lack created_at) — newest first.
function byIdDesc(a, b) { return String(b._id) > String(a._id) ? 1 : -1; }

export async function initCycleView(charList) {
  const el = document.getElementById('cycle-content');
  el.innerHTML = '<p class="placeholder">Loading…</p>';

  let chapters, cycles, sessions;
  try {
    [chapters, cycles, sessions] = await Promise.all([
      apiGet('/api/chapters'),
      apiGet('/api/downtime_cycles'),
      apiGet('/api/game_sessions'),
    ]);
  } catch (err) {
    el.innerHTML = `<p class="cy-error">Failed to load cycle data: ${err.message}</p>`;
    return;
  }

  view.chapters = chapters;
  view.cycles = cycles;
  view.sessions = sessions;
  view.charList = charList;

  el.innerHTML = '';
  el.appendChild(buildRibbon());
  el.appendChild(buildChaptersPanel(chapters));
  el.appendChild(buildCyclesPanel(cycles, chapters, charList, sessions));
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

/** Current cycle: the one in a set game phase, else newest non-closed. */
function deriveCurrentCycle() {
  const cycles = view.cycles || [];
  const inGame = cycles.find(c => c.game_phase === 'game');
  if (inGame) return inGame;
  const anyPhase = cycles.filter(c => c.game_phase).sort(byIdDesc)[0];
  if (anyPhase) return anyPhase;
  const nonClosed = cycles.filter(c => deriveCycleStatus(c) !== 'closed').sort(byIdDesc)[0];
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

  const chapter = cy.chapter_id
    ? view.chapters.find(ch => String(ch._id) === String(cy.chapter_id))
    : null;
  const chapterText = chapter ? `${chapter.number} — ${chapter.label}` : 'No chapter';
  const phaseText = cy.game_phase ? PHASE_LABELS[cy.game_phase] : 'No phase set';
  const phaseMod = cy.game_phase ? ` cy-phase--${cy.game_phase}` : ' cy-phase--none';

  el.innerHTML = `
    <div class="cy-ribbon-item">
      <span class="cy-ribbon-label">Chapter</span>
      <span class="cy-ribbon-val">${esc(chapterText)}</span>
    </div>
    <div class="cy-ribbon-item">
      <span class="cy-ribbon-label">Game Cycle</span>
      <span class="cy-ribbon-val">${esc(cy.label || String(cy._id))}</span>
      ${cycleSpanLabel(cy) ? `<span class="derived-note">${esc(cycleSpanLabel(cy))}</span>` : ''}
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

// ── Chapters panel ──────────────────────────────────────────────────────────

function buildChaptersPanel(chapters) {
  const wrap = document.createElement('div');
  wrap.className = 'cy-section';

  const header = document.createElement('div');
  header.className = 'cy-section-head';
  header.innerHTML = '<h3 class="cy-section-title">Chapters</h3>';

  const addBtn = document.createElement('button');
  addBtn.className = 'btn-sm';
  addBtn.textContent = '+ New Chapter';
  header.appendChild(addBtn);

  const errMsg = document.createElement('p');
  errMsg.className = 'cy-error cy-error--inline';

  wrap.appendChild(header);

  const table = document.createElement('table');
  table.className = 'infl-table cy-table';
  table.innerHTML = `<thead><tr>
    <th class="cy-col-num">#</th>
    <th>Label</th>
    <th class="cy-col-act"></th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  wrap.appendChild(table);
  wrap.appendChild(errMsg);

  function renderRows(list) {
    tbody.innerHTML = '';
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="cy-empty-cell">No chapters yet.</td></tr>';
      return;
    }
    list.forEach(ch => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${ch.number}</td>
        <td>${esc(ch.label)}</td>
        <td><button class="btn-sm btn-danger" data-id="${ch._id}">Delete</button></td>`;
      tr.querySelector('button').addEventListener('click', async () => {
        errMsg.classList.remove('is-visible');
        try {
          await apiDelete(`/api/chapters/${ch._id}`);
          renderRows(list.filter(c => c._id !== ch._id));
        } catch (err) {
          if (err.message && err.message.includes('cycle')) {
            errMsg.textContent = 'Chapter is linked to cycle(s) — remove the link before deleting.';
          } else {
            errMsg.textContent = `Delete failed: ${err.message}`;
          }
          errMsg.classList.add('is-visible');
        }
      });
      tbody.appendChild(tr);
    });
  }

  renderRows(chapters);

  // Inline new-chapter form
  const form = document.createElement('div');
  form.className = 'cy-inline-form';
  form.innerHTML = `
    <input id="new-ch-num" type="number" min="1" placeholder="Number" class="form-input cy-input-num">
    <input id="new-ch-label" type="text" placeholder="Label (e.g. Chapter Two: The Price of Power)" class="form-input cy-input-grow">
    <button class="btn-sm" id="new-ch-save">Save</button>
    <button class="btn-sm btn-muted" id="new-ch-cancel">Cancel</button>`;
  wrap.appendChild(form);

  addBtn.addEventListener('click', () => {
    form.classList.add('is-open');
    addBtn.classList.add('is-hidden');
    errMsg.classList.remove('is-visible');
    form.querySelector('#new-ch-num').value = '';
    form.querySelector('#new-ch-label').value = '';
    form.querySelector('#new-ch-num').focus();
  });

  form.querySelector('#new-ch-cancel').addEventListener('click', () => {
    form.classList.remove('is-open');
    addBtn.classList.remove('is-hidden');
  });

  form.querySelector('#new-ch-save').addEventListener('click', async () => {
    const number = parseInt(form.querySelector('#new-ch-num').value, 10);
    const label  = form.querySelector('#new-ch-label').value.trim();
    if (!number || !label) {
      errMsg.textContent = 'Both Number and Label are required.';
      errMsg.classList.add('is-visible');
      return;
    }
    errMsg.classList.remove('is-visible');
    try {
      const created = await apiPost('/api/chapters', { number, label });
      chapters = [...chapters, created].sort((a, b) => a.number - b.number);
      view.chapters = chapters;
      renderRows(chapters);
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

// ── Phase controls ───────────────────────────────────────────────────────────

// Write a phase to a cycle. `phaseOrNull === null` clears the phase (neutral).
// Only entering Game phase resets the live tracker — clearing does NOT.
// Returns false if the ST cancels the Game-phase confirmation.
async function writePhase(cy, phaseOrNull) {
  if (phaseOrNull === 'game') {
    // #1003: warn if flipping an empty cycle to game while another live cycle
    // holds submissions (feeding pulls from the game-phase cycle).
    const warn = await zeroSubmissionFlipWarning(
      cy, view.cycles || [], async id => (await getSubmissionsForCycle(id)).length);
    if (warn && !confirm(zeroSubmissionFlipMessage(warn))) return false;
    // #1002: state what the flip means - it opens session play for THIS cycle's
    // submissions, which feed the following game.
    const feeds = cycleFeedsLabel(cy);
    const meaning = feeds
      ? `This opens session play for the downtimes submitted in this cycle (${feeds}) and resets the live tracker (all characters reload with default states). Continue?`
      : 'Setting to Game phase will reset the live tracker (all characters reload with default states). Continue?';
    if (!confirm(meaning)) return false;
    try {
      await apiDelete('/api/tracker_state');
    } catch (err) {
      throw new Error('Tracker reset failed: ' + err.message);
    }
  }
  // #1001: write the derived legacy `status` alongside game_phase so raw
  // `status` readers (getActiveCycle, LIVE_STATUSES filters) stay consistent
  // with the phase while legacy status-based readers still exist.
  const status = deriveCycleStatus({ ...cy, game_phase: phaseOrNull });
  await apiPut('/api/downtime_cycles/' + cy._id, { game_phase: phaseOrNull, status });
  cy.game_phase = phaseOrNull;
  cy.status = status;
  return true;
}

function buildPhaseCell(cy) {
  const td = document.createElement('td');
  td.className = 'cy-phase-cell';

  const group = document.createElement('div');
  group.className = 'cy-phase-group';
  td.appendChild(group);

  const errEl = document.createElement('span');
  errEl.className = 'cy-error cy-error--inline';

  PHASES.forEach(phase => {
    const btn = document.createElement('button');
    btn.className = 'cy-phase-btn' + (cy.game_phase === phase ? ' is-active' : '');
    btn.textContent = PHASE_LABELS[phase];
    btn.dataset.phase = phase;
    btn.title = cy.game_phase === phase ? 'Click to clear this phase' : `Set ${PHASE_LABELS[phase]} phase`;

    btn.addEventListener('click', async () => {
      errEl.classList.remove('is-visible');
      // Active phase toggles OFF to neutral; otherwise switch to the clicked phase.
      const target = (cy.game_phase === phase) ? null : phase;
      try {
        const ok = await writePhase(cy, target);
        if (!ok) return;
        group.querySelectorAll('.cy-phase-btn').forEach(b => {
          const active = b.dataset.phase === cy.game_phase;
          b.classList.toggle('is-active', active);
          b.title = active ? 'Click to clear this phase' : `Set ${PHASE_LABELS[b.dataset.phase]} phase`;
        });
        renderRibbon();
      } catch (err) {
        errEl.textContent = 'Phase change failed: ' + err.message;
        errEl.classList.add('is-visible');
      }
    });
    group.appendChild(btn);
  });

  td.appendChild(errEl);
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
        await apiPut('/api/downtime_cycles/' + cy._id, { out_of_window_player_ids: updated });
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
      await apiPut('/api/downtime_cycles/' + cy._id, { session_id: newId });
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

// Build a chapter <select>. Options-only; no persistence handler — used for
// the add-cycle form (which has no cycle to write to yet).
function buildChapterPicker(chapters, selectedId = '') {
  const sel = document.createElement('select');
  sel.className = 'form-select cy-chapter-select';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— none —';
  sel.appendChild(none);
  [...chapters].sort((a, b) => a.number - b.number).forEach(ch => {
    const opt = document.createElement('option');
    opt.value = String(ch._id);
    opt.textContent = `${ch.number} — ${ch.label}`;
    sel.appendChild(opt);
  });
  sel.value = selectedId ? String(selectedId) : '';
  return sel;
}

// Row-level chapter select: persists chapter_id to an existing cycle on change.
function buildChapterSelect(cy, chapters) {
  const sel = buildChapterPicker(chapters, cy.chapter_id);
  sel.addEventListener('change', async () => {
    const val = sel.value || null;
    try {
      await updateCycle(cy._id, { chapter_id: val });
      cy.chapter_id = val;
      renderRibbon();
    } catch (err) {
      sel.value = cy.chapter_id ? String(cy.chapter_id) : '';
    }
  });
  return sel;
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
    // #1002: derived feeds-into span so the cycle name can't be mistaken for the
    // session it actually feeds.
    const spanText = cycleSpanLabel(cy);
    if (spanText) {
      const note = document.createElement('span');
      note.className = 'derived-note';
      note.textContent = spanText;
      td.appendChild(note);
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

function buildCyclesPanel(cycles, chapters, charList = [], sessions = []) {
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
  const chapterPick = buildChapterPicker(chapters);
  chapterPick.id = 'new-cy-chapter';
  addForm.insertBefore(chapterPick, addForm.querySelector('#new-cy-save'));
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
    const chapterId = addForm.querySelector('#new-cy-chapter').value || null;
    if (!num || !label) {
      errMsg.textContent = 'Game number and label are required.';
      errMsg.classList.add('is-visible');
      return;
    }
    errMsg.classList.remove('is-visible');
    try {
      await createCycle(num, { label, chapterId });
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
    <th class="cy-col-chapter">Chapter</th>
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

    const tdChapter = document.createElement('td');
    tdChapter.appendChild(buildChapterSelect(cy, chapters));
    tr.appendChild(tdChapter);

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
        const result = await apiPost('/api/downtime_cycles/' + cy._id + '/publish', {});
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
