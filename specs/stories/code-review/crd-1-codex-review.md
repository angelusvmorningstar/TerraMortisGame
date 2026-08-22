# Adversarial review - crd.1 (Data-lock, schema hardening, WP-rule spike), TM Game

You are reviewing a completed change in a repo you have full access to. You have NONE of the
conversation in which it was written, which is the point: you are here to catch what the author
could not catch about their own work.

## How to run this - read this section before anything else

This is **three passes in one session, in a fixed order**, and the order is load-bearing. Each pass
is allowed to see strictly more than the one before it. You cannot un-read a spec, so the pass that
must judge the code cold goes first.

1. Work the passes **in the order written**. Do not read ahead. Do not open a file a later pass
   grants you until you reach that pass. In particular: **the story spec is deliberately NOT in the
   diff.** Do not go looking for it during the earlier passes. The final pass will hand you the path.
2. **Freeze each pass before advancing.** Write that pass's findings out in full, to
   `specs/stories/code-review/crd-1-codex-findings.md`, before you open anything the next pass
   allows. Do not revise an earlier pass's findings in light of what a later pass taught you - if a
   later pass contradicts an earlier one, say so as a new finding and leave the original standing.
3. At the very end, **attest** to what you actually did: which files you opened in each pass, which
   commands you ran, and anything you could not run. Do not paper over a gap - see "Honesty" below.

## Ground rules

- Repo root: `D:\Terra Mortis\TM Game`. The diff is at `specs/stories/code-review/crd-1-diff.txt`
  and is relative to that root, taken against base commit `08dd1487` (the tip of `origin/main`
  before this branch existed) up to commit `680a95a1` on branch
  `ms/crd-1-data-lock-schema-hardening-wp-spike`.
- The diff is **deliberately scoped to source and tooling only** (`server/`). Story-spec and
  tracking edits (the epic file, the story file, `sprint-status.yaml`, and an unrelated superseded-
  story edit) are excluded from it on purpose, so the earlier passes stay genuinely blind to the
  author's own account. Do not treat their absence as an omission or go hunting for them.
- **Read and run freely** to verify a claim. Running the code beats reasoning about it every time.
- **Do NOT modify, commit, or push anything.** This repo (`TM Game`) sits in an umbrella workspace
  alongside sibling repos (`TM Story`, `TM Admin`, `TM Herald`, `TM Design System`) at
  `D:\Terra Mortis\`. Do not read or touch anything outside `D:\Terra Mortis\TM Game` even to
  cross-reference - everything you need is in this repo.
- Temporarily editing a file to prove something (revert one line, confirm the check now fails the way
  you expect, restore it) **is allowed and encouraged** - you MUST restore it exactly, confirm the
  restore with `git diff`, and say so in your output.
- **Environment hazard**: several test suites in this project need a live local MongoDB. This repo's
  tests are written to skip cleanly (`describe.skipIf(!dbAvailable)`) rather than fail when Mongo is
  unreachable - if you see suites reporting far fewer tests than the file's own test count, that is
  likely a skip, not a pass; check for a "skip" indicator in the output and disclose it rather than
  reporting a skipped file as a clean pass. Do not attempt to start MongoDB yourself if it is not
  already running - report what you can and cannot verify.
- **Blast radius note**: `contested_roll_requests` is a SHARED collection - it also holds a
  completely different feature's records (`request_type: 'status_action'`, the ST-facing Office
  Approval Queue, Epic OAQ, already live in production). A mistake in this diff's route-guard
  scoping doesn't just affect the new feature, it can silently corrupt or leak the OAQ queue too -
  that collection has a documented history of exactly this kind of bug already (an orphaning bug
  from a previous story, referenced in code comments in this diff as "the oaq.3 void-orphaning
  bug"). Weight anything touching a query filter, guard clause, or index on this collection
  accordingly.

## Honesty requirements (these outrank completeness)

- If you could not run something, **say so plainly and name what you could not run**. A disclosed gap
  is far more useful than a confident static read presented as a verified one.
- If you found nothing in a pass or at a severity, **say that explicitly** rather than omitting the
  section or padding with style opinions.
- Report the **exact current gate numbers** you observe: `cd server && npx vitest run tests/crd-1-contested-roll-request-shape.test.js` (the new suite), and the changed-area regression set you determine in Pass 3b below. Report the real numbers
  even if they disagree with anything the story claims - especially then.

---

## PASS 1 - BLIND HUNTER (the diff, and nothing else)

You get the diff at `specs/stories/code-review/crd-1-diff.txt` and **nothing else**. No spec, no
story file, no project context. Do not explore the repository. Do not go looking for the spec. Read
other files only to resolve an import path the diff itself leaves ambiguous.

The blinding is the point. You are here to catch what a competent reviewer with zero project memory
would catch, uncontaminated by the author's framing of what the change was supposed to do.

### What this diff claims to be

A data-hardening change to a `contested_roll_requests` MongoDB collection shared by two features. It
loosens a JSON-schema requirement (`defender_pool` was required at document creation, now optional),
adds a `request_type` discriminator field that a route now sets explicitly server-side, tightens a
`GET /mine` query filter that previously had no type-scoping at all, and adds two new MongoDB
indexes (a compound query index and a TTL index) at server boot.

**That is the shape it claims. Do not trust the shape - verify it.**

### What to hunt for

1. **The single most important thing to verify in this whole diff, read the diff carefully for it**:
   `server/routes/contested-rolls.js`'s `POST /` no longer requires `defender_pool` at creation
   (confirmed by the schema diff removing it from `required`), but the diff does NOT touch the
   `PUT /:id/accept` route at all - that route is unchanged and not shown here. If `/accept` reads
   `defender_pool` directly off the stored document to decide how many dice to roll for the
   defender, what happens when a document was created via the new, schema-valid path with NO
   `defender_pool` at all, and someone then calls `/accept` on it? Trace this as carefully as you
   can from the diff alone; if the diff doesn't give you enough to answer it, say explicitly that
   this needs Pass 2's full repo access and flag it as the top priority to resolve there.
2. `contested-rolls.js`'s `GET /mine` filter changed from `find({ target_character_id: {...},
   status: 'pending' })` to also filtering `request_type: { $in: [null, 'contested_roll'] }`. Is
   `$in` with a `null` member in the array the correct MongoDB idiom for "field is absent OR
   explicitly null"? Is there a difference between `{ $in: [null, X] }` and `{ $eq: null }` /
   `{ $exists: false }` worth flagging, or is this exactly equivalent and fine?
3. The new test `'a client-supplied request_type can never override the server\'s own value'`
   verifies its claim by reading `contested-rolls.js`'s own SOURCE TEXT and checking the string
   index of `'...req.body'` versus `'request_type'` inside a sliced block - it does not send two
   requests and observe which value actually wins at runtime. Does this test's PASS condition
   actually verify the behaviour its own title claims, or does it only verify source-code layout
   (which could stay "passing" under a refactor that changes the actual runtime precedence while
   keeping the same relative text order, or vice versa)? Is this even a meaningful gap given the
   schema's `enum: ['contested_roll']` already makes any other client-supplied value a 400 before
   this code ever runs - i.e., is the test's own premise (a client "overriding" the value) already
   structurally impossible, making this a test of a scenario that cannot occur?
4. The new TTL index (`server/index.js`) is created with `createIndex(...)` **not awaited** during
   `start()`, and the code comment claims this is deliberate and safe because, unlike a neighbouring
   unique index, it "cannot reject at build time on live data." Read the surrounding `start()`
   function structure in the diff: is there anything that suggests the app can begin serving
   requests before these un-awaited `createIndex` calls resolve? If so, is that a real problem (a
   query racing ahead of index creation just performs an unindexed scan until the index exists -
   slower, not wrong) or is there a scenario where it's NOT just a performance concern?
5. Standard hunt items, apply as relevant: assertions whose PASS condition is trivially satisfiable;
   a check whose label claims more than it tests (beyond the #3 case above); error paths and
   unhandled rejections around the new un-awaited `createIndex` calls; dead code or unused imports;
   self-contradiction within the diff itself (e.g. a comment claiming a guard already existed
   correctly, contradicted by the actual diff hunk right next to it).

**STOP. Write your Pass 1 findings to `specs/stories/code-review/crd-1-codex-findings.md` now,
before reading further.**

---

## PASS 2 - EDGE CASE HUNTER (the diff, plus the repository)

You now have full read access to `D:\Terra Mortis\TM Game`. Read whatever surrounding code you need
to understand what this change is actually plugging into. You still do **not** have the story spec
or any account of the author's intent - work from the code itself.

Your remit is boundaries and branches: walk every path, not just the one the author had in mind.

### Orientation (not ground truth - verify against the code)

Same summary as Pass 1. Additionally: this collection (`contested_roll_requests`) is shared with a
second, unrelated, already-shipped feature (`request_type: 'status_action'`, written by a different
route file, `server/routes/office-actions.js`).

### What to hunt for

1. **Resolve item 1 from Pass 1 now, with full repo access.** Open `server/routes/contested-rolls.js`
   in full. Find `PUT /:id/accept` and the `_roll(n)` helper function it calls. Trace exactly what
   `_roll(undefined)` returns (read the function body, don't guess), and what the accept route then
   does with that result - does it error, does it silently produce a degenerate roll, does anything
   downstream (`res.json`, `session_logs` write, whatever consumes the result) break or misbehave?
   State plainly whether a contested-roll request created via the new code path (no `defender_pool`
   supplied, which is now valid) can currently be accepted via `/accept` today, on this branch, and
   what actually happens if it is. This is the single highest-value thing this pass can resolve.
2. Read `_findChallenge` and `PUT /:id/void`'s real current implementation in full (both are
   UNCHANGED by this diff - go find them in the live file, don't infer from the diff). Confirm,
   by reading the actual guard clause each one uses, whether they already correctly exclude
   `status_action` documents and correctly include both legacy (no `request_type` field) and new
   (`request_type: 'contested_roll'`) documents - the diff's own comments claim these two routes
   were "already correct" and deliberately left untouched. Verify that claim against the real code
   rather than trusting the comment.
3. Search the whole `server/` tree for every place that writes to the `contested_roll_requests`
   collection (`insertOne`, `updateOne`, `findOneAndUpdate`, etc. against this collection name) and
   every place that queries it. For each writer, does it set `request_type` explicitly, leave it
   absent (legacy shape), or something else? For each query, is it now correctly scoped to the
   type(s) it means to touch, given the new discriminator exists? Name any query you find that is
   NOT part of this diff and is NOT already covered by items 1-2 above.
4. `office-actions.js` writes `target_id` on `status_action` documents, not `target_character_id` -
   a code comment in this diff claims that field-name difference is the ONLY reason a `status_action`
   document has never leaked into `GET /mine`'s results historically. Confirm this by reading
   `office-actions.js`'s actual insert code for `status_action` documents - does any code path,
   anywhere in this collection's writers, ever set `target_character_id` on a `status_action`
   shaped document? (The new filter is now scoped by `request_type` explicitly regardless of the
   answer, so this doesn't affect whether the NEW code is safe - but confirm whether the diff's
   stated reasoning about the OLD code's safety is actually accurate.)
5. Malformed/absent input at the new schema fields: what does the AJV schema do with
   `defender_merit_ids: []` (empty array, not absent)? With `defender_aspect: ''` (empty string, not
   a valid enum member, but also not absent)? Are these handled the same way absence is, or
   differently, and does that matter for whatever will eventually read these fields?
6. Route/matcher order: does adding `request_type` handling anywhere change which route Express
   matches for a given request, or is this purely a body-shape and query-filter change with no
   routing implications?

**STOP. Write your Pass 2 findings to `specs/stories/code-review/crd-1-codex-findings.md` now,
before reading further.**

---

## PASS 3 - ACCEPTANCE AUDITOR (the diff, plus the spec)

Two sub-passes, in this order. **The order is the highest-value instruction in this whole document.**

### Pass 3a - form findings BEFORE reading the author's own account

1. Read `specs/stories/crd-1-data-lock-schema-hardening-wp-spike.md` - the **Story**, **Acceptance
   Criteria**, **Tasks/Subtasks**, and **Dev Notes** sections ONLY. Also read
   `specs/epic-crd-contested-roll-defence.md` for the parent epic's own scope/decisions.
2. **Do NOT read the Dev Agent Record or any Senior Developer Review section yet.** Skip past them
   entirely. Reading the author's own record first anchors you on their framing and turns a review
   into grading homework.
3. Against the acceptance criteria, check the diff and the real code it touches for:
   - Violations of an AC's **literal wording**. Read the words, not the surrounding narrative - an AC's
     exception is exactly as narrow as it is written.
   - Deviations from stated intent. **The "What this story is NOT" section is equally load-bearing** -
     check the change did not quietly do an excluded thing.
   - Specified behaviour that is missing, or present only in appearance.
   - Contradictions between a stated constraint and the actual code.
   - **Specifically**: does the story's own text acknowledge the accept-route gap you investigated in
     Pass 2 item 1 (whether an unresolved contested-roll request can currently be accepted and
     produce a degenerate result)? If the story is silent on it, that is itself a finding - either
     the gap is real and unaddressed, or it's genuinely a non-issue for a reason the story should
     have stated but didn't.
4. **Write your Pass 3a findings down now, before moving on.**

Explicitly NOT in scope for crd.1, and deliberate - do not flag these as gaps on their own (though
they may be RELEVANT CONTEXT for the accept-route question above, which is squarely this story's
concern):
- Actually computing `defender_pool` server-side from a defender's submitted choices (aspect,
  merits, Willpower) - that is a separate future story (crd.3a), not built here.
- Converting `updated_at` from an ISO string to a real BSON Date so the new TTL index actually
  reaps anything - documented as a known, deliberate limitation with its own test, follow-up story
  needed.
- Any UI/client-side work (a defender-facing queue or resolution screen) - `roll-v2.js` was
  deliberately not touched by this story; a hardcoded `wpBonus = state.WP ? 3 : 0` shared literal
  found there is recorded as a finding for a *future* story to work around, not something crd.1
  changes.

### Pass 3b - now read the author's record and check it against reality

5. Now read the **Dev Agent Record** in full. It makes specific, checkable claims, including:
   - "New suite: 34/34" for `crd-1-contested-roll-request-shape.test.js`.
   - A changed-area regression count and a claim that exactly one failure is pre-existing and
     unrelated, reproducing identically with this diff's changes stashed.
   - A live-data spot-check against 43 real characters in the `tm_game` database (not the test DB)
     confirming merit/attribute field shapes.
   - Specific claims about which existing routes/guards were found "already correct" and left alone.
6. **Verify each claim by running it, not by reading it.** Run
   `cd server && npx vitest run tests/crd-1-contested-roll-request-shape.test.js` yourself, right
   now, and report the real result. Then determine the real "changed area" test set yourself (grep
   for existing test files that reference `contested_roll_requests`, `contested-rolls`, or the
   index-creation section of `server/index.js`) and run that set. If MongoDB is unavailable in your
   environment and tests skip rather than run, say so explicitly rather than reporting a skip as a
   pass. You do NOT need to reproduce the live `tm_game` spot-check (do not connect to production
   data) - instead, read the real `server/schemas/character.schema.js` yourself and confirm the
   *shape* claims (merits use `rating`, attributes have `dots`/`bonus`) are consistent with what
   the live schema actually enforces.
7. Flag anything **FALSE, OVERSTATED, or UNVERIFIABLE-AS-STATED**. This is the single highest-value
   thing this pass can find. A record's own "confirmed", "verified" or "resolved" label can itself be
   wrong - re-examine each one rather than inheriting it.
8. State plainly whether you believe this change is ready to ship as-is, needs patches, or has a
   blocking problem - and be explicit about how the Pass 2 item 1 finding (the accept-route gap)
   factors into that verdict specifically.

---

## Output

Write everything to `specs/stories/code-review/crd-1-codex-findings.md`, grouped `## High` /
`## Medium` / `## Low`, each finding tagged with the pass that produced it (`[Pass 1]`, `[Pass 2]`,
`[Pass 3a]`, `[Pass 3b]`). Write `- None found.` under any empty heading rather than dropping it.

For each finding:

- **One-line title**
- **Severity**: High / Medium / Low
- **File:line**
- **The triggering input or sequence** - be concrete about what reaches it
- **The observable consequence** - what actually goes wrong, for whom
- **Confidence**: how sure you are this is real and not a misread

Close with a **Validation notes** section stating:

- Which files you opened in each pass, and confirmation you did not read ahead.
- Every command you ran, with its real result, including the gate commands named above.
- **Anything you could not run, and why.** Name it specifically.
- Confirmation that you modified nothing, or that anything you touched was restored and verified
  (`git status --short` clean of unintended change).
