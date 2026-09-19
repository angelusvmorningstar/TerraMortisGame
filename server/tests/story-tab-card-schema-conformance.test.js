/**
 * Story tm-admin.21.1 (AC 6): fixture-based conformance test for the per-action card
 * schema ruled in ../TM Admin/specs/downtime-publishing-schema.md.
 *
 * The ruled card shape is:
 *
 *   <Title>
 *   <Outcome, narrative prose>
 *   > Results: <number of successes>      (only if a dice roll happened)
 *   > Results: <the actual dice numbers>  (only if a dice roll happened)
 *   > Desired Outcome: <player-submitted> (muted)
 *   > Approach: <player-submitted>        (muted)
 *
 * All four lines live together in ONE blockquote, in that order.
 *
 * Tested against the real exported renderOutcomeWithCards (public/js/tabs/story-tab.js),
 * not reimplemented render logic, mirroring story-tab-cross-app-render.test.js.
 */

import { describe, it, expect } from 'vitest';

// renderOutcomeWithCards reaches into ../auth/discord.js for isSTRole()/getPlayerInfo()
// (the per-section flag affordance), which reads localStorage. Same stub the sibling
// story-tab-cross-app-render.test.js uses.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderOutcomeWithCards } from '../../public/js/tabs/story-tab.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const QUOTE_RE = /<blockquote class="proj-card-quote">([\s\S]*?)<\/blockquote>/;

function quoteOf(html) {
  const m = html.match(QUOTE_RE);
  return m ? m[1] : null;
}

/** A project submission with one declared, resolved, published project slot. */
function projectSub({ roll = null, desired = '', approach = '' } = {}) {
  const responses = { project_1_title: 'The Quiet Ledger' };
  if (desired)  responses.project_1_outcome     = desired;
  if (approach) responses.project_1_description = approach;
  return {
    _id: 'sub-proj',
    character_id: 'charA',
    published_outcome: 'The books balanced, eventually.',
    responses,
    projects_resolved: [{
      action_type: 'investigate',
      outcome_confirmed: true,
      outcome: 'The ledger gave up three names.',
      pool_validated: 'Intelligence + Investigation',
      ...(roll ? { roll } : { no_roll: true }),
    }],
  };
}

/** A merit submission with one declared sphere action, resolved and rolled. */
function meritSub({ desired = '' } = {}) {
  return {
    _id: 'sub-merit',
    character_id: 'charA',
    published_outcome: 'Word travelled.',
    responses: {
      sphere_1_merit: 'Sway ●●● (Finance)',
      sphere_1_action: 'grow',
      sphere_1_outcome: desired,
    },
    merit_actions_resolved: [{
      pool_validated: 'Manipulation + Persuasion',
      roll: { successes: 3, exceptional: false, dice_string: '9, 2, 7, 8' },
    }],
  };
}

describe('tm-admin.21.1 AC 6a: a rolled project with both declared fields renders all four blockquote lines in the ruled order', () => {
  const html = renderOutcomeWithCards(projectSub({
    roll: { successes: 2, exceptional: false, dice_string: '1, 3, 8, 3, 8, 6' },
    desired: 'Find out who has been skimming the tithe.',
    approach: 'Quietly, through the counting house clerks.',
  }));
  const quote = quoteOf(html);

  it('renders a single proj-card-quote blockquote', () => {
    expect(quote).not.toBeNull();
    expect(html.match(/<blockquote class="proj-card-quote">/g)).toHaveLength(1);
  });

  it('puts all four lines inside that one blockquote', () => {
    expect(quote).toContain('Results: 2 Successes');
    expect(quote).toContain('Results: 1, 3, 8, 3, 8, 6');
    expect(quote).toContain('Desired Outcome:');
    expect(quote).toContain('Find out who has been skimming the tithe.');
    expect(quote).toContain('Approach:');
    expect(quote).toContain('Quietly, through the counting house clerks.');
  });

  it('orders them Results successes, Results dice, Desired Outcome, Approach', () => {
    const iSuc      = quote.indexOf('Results: 2 Successes');
    const iDice     = quote.indexOf('Results: 1, 3, 8, 3, 8, 6');
    const iDesired  = quote.indexOf('Desired Outcome:');
    const iApproach = quote.indexOf('Approach:');
    expect(iSuc).toBeGreaterThan(-1);
    expect(iSuc).toBeLessThan(iDice);
    expect(iDice).toBeLessThan(iDesired);
    expect(iDesired).toBeLessThan(iApproach);
  });

  it('keeps the title and the ST-authored outcome outside the blockquote, at full weight', () => {
    expect(html).toContain('The Quiet Ledger');
    expect(quote).not.toContain('The Quiet Ledger');
  });

  it('gives BOTH declared lines the muted treatment, label span included', () => {
    expect(quote.match(/class="proj-card-declared"/g)).toHaveLength(2);
    expect(quote.match(/class="proj-card-declared-label"/g)).toHaveLength(2);
  });
});

describe('tm-admin.21.1 AC 3: the reworded Results line keeps its existing coloured treatment', () => {
  it('keeps proj-card-roll-exc on an exceptional success, and words it Results:', () => {
    const quote = quoteOf(renderOutcomeWithCards(projectSub({
      roll: { successes: 5, exceptional: true, dice_string: '8, 9, 10, 7, 8' },
    })));
    expect(quote).toContain('<div class="proj-card-roll proj-card-roll-exc">Results: Exceptional Success</div>');
  });

  it('keeps proj-card-roll-fail on a failure, and words it Results:', () => {
    const quote = quoteOf(renderOutcomeWithCards(projectSub({
      roll: { successes: 0, exceptional: false, dice_string: '2, 4, 1' },
    })));
    expect(quote).toContain('<div class="proj-card-roll proj-card-roll-fail">Results: Failure</div>');
  });

  it('carries no colour class on an ordinary success', () => {
    const quote = quoteOf(renderOutcomeWithCards(projectSub({
      roll: { successes: 2, exceptional: false, dice_string: '8, 9' },
    })));
    expect(quote).toContain('<div class="proj-card-roll">Results: 2 Successes</div>');
    expect(quote).not.toContain('proj-card-roll-exc');
    expect(quote).not.toContain('proj-card-roll-fail');
  });

  it('keeps the same coloured treatment on a merit card', () => {
    const html = renderOutcomeWithCards({
      _id: 'sub-merit-exc',
      character_id: 'charA',
      published_outcome: 'Word travelled.',
      responses: { sphere_1_merit: 'Sway ●●● (Finance)', sphere_1_action: 'grow', sphere_1_outcome: 'A name.' },
      merit_actions_resolved: [{ pool_validated: 'Manipulation + Persuasion', roll: { successes: 4, exceptional: true, dice_string: '10, 9, 8, 8' } }],
    });
    expect(quoteOf(html)).toContain('<div class="proj-card-roll proj-card-roll-exc">Results: Exceptional Success</div>');
  });
});

describe('tm-admin.21.1 AC 1: the declared fields use the same top-level fallback as the title lookup', () => {
  it('reads project_N_outcome / project_N_description off the submission root when there is no responses object', () => {
    const quote = quoteOf(renderOutcomeWithCards({
      _id: 'sub-flat',
      character_id: 'charA',
      published_outcome: 'The books balanced, eventually.',
      project_1_title: 'The Quiet Ledger',
      project_1_outcome: 'Find out who has been skimming the tithe.',
      project_1_description: 'Quietly, through the counting house clerks.',
      projects_resolved: [{
        action_type: 'investigate',
        outcome_confirmed: true,
        outcome: 'The ledger gave up three names.',
        roll: { successes: 2, exceptional: false, dice_string: '8, 9' },
      }],
    }));
    expect(quote).toContain('Find out who has been skimming the tithe.');
    expect(quote).toContain('Quietly, through the counting house clerks.');
  });
});

describe('tm-admin.21.1: a non-string declared value degrades rather than blanking the whole report', () => {
  it('does not throw when a declared field holds a number or an object', () => {
    let html;
    expect(() => {
      html = renderOutcomeWithCards({
        _id: 'sub-nonstring',
        character_id: 'charA',
        published_outcome: 'The books balanced, eventually.',
        responses: { project_1_title: 'The Quiet Ledger', project_1_outcome: 7 },
        project_1_description: { not: 'a string' },
        projects_resolved: [{ action_type: 'investigate', outcome_confirmed: true, outcome: 'Three names.' }],
      });
    }).not.toThrow();
    // The rest of the report still renders rather than dying with the bad field.
    expect(html).toContain('The Quiet Ledger');
    expect(html).toContain('Desired Outcome:');
  });
});

describe('tm-admin.21.1 AC 6b: a rolled project with only one declared field renders exactly that one, never an empty row', () => {
  it('renders Desired Outcome only, when only Desired Outcome was filled in', () => {
    const quote = quoteOf(renderOutcomeWithCards(projectSub({
      roll: { successes: 1, exceptional: false, dice_string: '8' },
      desired: 'Find out who has been skimming the tithe.',
    })));
    expect(quote).toContain('Desired Outcome:');
    expect(quote).not.toContain('Approach:');
  });

  it('renders Approach only, when only Approach was filled in', () => {
    const quote = quoteOf(renderOutcomeWithCards(projectSub({
      roll: { successes: 1, exceptional: false, dice_string: '8' },
      approach: 'Quietly, through the counting house clerks.',
    })));
    expect(quote).toContain('Approach:');
    expect(quote).not.toContain('Desired Outcome:');
  });

  it('renders no blockquote at all when a project has a roll but neither declared field', () => {
    const html = renderOutcomeWithCards(projectSub({
      roll: { successes: 1, exceptional: false, dice_string: '8' },
    }));
    const quote = quoteOf(html);
    expect(quote).toContain('Results: 1 Success');
    expect(quote).not.toContain('Desired Outcome:');
    expect(quote).not.toContain('Approach:');
  });
});

describe('tm-admin.21.1 AC 6c: a no-roll project renders zero Results lines but keeps its declared lines', () => {
  const html = renderOutcomeWithCards(projectSub({
    desired: 'Find out who has been skimming the tithe.',
    approach: 'Quietly, through the counting house clerks.',
  }));
  const quote = quoteOf(html);

  it('renders no Results line at all', () => {
    expect(html).not.toContain('Results:');
  });

  it('still renders both declared lines, in the ruled order', () => {
    expect(quote).not.toBeNull();
    expect(quote.indexOf('Desired Outcome:')).toBeLessThan(quote.indexOf('Approach:'));
  });
});

describe('tm-admin.21.1 AC 6d: a Merit card renders one uniformly-labelled Desired Outcome line and never an Approach line', () => {
  const html = renderOutcomeWithCards(meritSub({ desired: 'Lean on the brokers for a name.' }));
  const quote = quoteOf(html);

  it('renders the merit card with its Results lines and its single declared line, all in one blockquote', () => {
    expect(quote).not.toBeNull();
    expect(quote).toContain('Results: 3 Successes');
    expect(quote).toContain('Results: 9, 2, 7, 8');
    expect(quote).toContain('Desired Outcome:');
    expect(quote).toContain('Lean on the brokers for a name.');
  });

  it('never renders an Approach line, because a merit action structurally has only one declared field', () => {
    expect(html).not.toContain('Approach:');
  });

  it('orders the merit blockquote the same way as a project blockquote', () => {
    const iSuc     = quote.indexOf('Results: 3 Successes');
    const iDice    = quote.indexOf('Results: 9, 2, 7, 8');
    const iDesired = quote.indexOf('Desired Outcome:');
    expect(iSuc).toBeLessThan(iDice);
    expect(iDice).toBeLessThan(iDesired);
  });

  it('renders no blockquote for a merit action with no roll and no declared text', () => {
    const bare = renderOutcomeWithCards({
      _id: 'sub-merit-bare',
      character_id: 'charA',
      published_outcome: 'Word travelled.',
      responses: { sphere_1_merit: 'Sway ●●● (Finance)', sphere_1_action: 'grow', sphere_1_outcome: '' },
      merit_actions_resolved: [{ pool_validated: 'Manipulation + Persuasion' }],
    });
    expect(bare).toContain('proj-card');
    expect(quoteOf(bare)).toBeNull();
  });
});

describe('tm-admin.21.1 AC 3: a no_roll action renders no Results lines, even carrying stale roll data', () => {
  // The ruled rule is "only if a dice roll happened". An action flagged no_roll did not roll,
  // so stale roll data left on it must not surface as a Results line. TM Story's own half of
  // this conformance work (tm-admin.21.2) gates the same way, so the two apps agree.
  it('suppresses both Results lines on a no_roll project that still carries a roll object', () => {
    const html = renderOutcomeWithCards({
      _id: 'sub-noroll-stale',
      character_id: 'charA',
      published_outcome: 'The books balanced, eventually.',
      responses: {
        project_1_title: 'The Quiet Ledger',
        project_1_outcome: 'Find out who has been skimming the tithe.',
      },
      projects_resolved: [{
        action_type: 'maintenance',
        outcome_confirmed: true,
        outcome: 'Kept ticking over.',
        no_roll: true,
        roll: { successes: 3, exceptional: false, dice_string: '8, 9, 10' },
      }],
    });
    expect(html).not.toContain('Results:');
    // The declared line the player did fill in still renders.
    expect(quoteOf(html)).toContain('Desired Outcome:');
  });

  it('suppresses both Results lines on a no_roll merit action that still carries a roll object', () => {
    const html = renderOutcomeWithCards({
      _id: 'sub-merit-noroll',
      character_id: 'charA',
      published_outcome: 'Word travelled.',
      responses: { sphere_1_merit: 'Sway ●●● (Finance)', sphere_1_action: 'grow', sphere_1_outcome: 'A name.' },
      merit_actions_resolved: [{
        pool_validated: 'Manipulation + Persuasion',
        no_roll: true,
        roll: { successes: 3, exceptional: false, dice_string: '8, 9, 10' },
      }],
    });
    expect(html).not.toContain('Results:');
    expect(quoteOf(html)).toContain('Desired Outcome:');
  });
});

describe('tm-admin.21.1 AC 5/AC 8: the card quote survives the reading-pane cascade on the Archive tab', () => {
  // archive-tab.js renders renderOutcomeWithCards inside <div class="... reading-pane">,
  // and components.css carries a generic `.reading-pane blockquote` rule (crimson rule,
  // tinted background, italics). A bare `.proj-card-quote` selector, at the same
  // specificity as a single class, loses to it, so the same card would render one way on
  // the Story and Downtime tabs and another on the Archive tab. The rule must therefore
  // stay scoped under .proj-card AND restate every property that generic rule sets.
  const css = readFileSync(path.join(REPO_ROOT, 'public', 'css', 'components.css'), 'utf8');
  const rule = css.match(/\.proj-card \.proj-card-quote\s*\{([^}]*)\}/);

  it('scopes the quote rule under .proj-card so it out-specifies .reading-pane blockquote', () => {
    expect(rule).not.toBeNull();
  });

  it('restates every property .reading-pane blockquote would otherwise impose', () => {
    const generic = css.match(/\.reading-pane blockquote\s*\{([^}]*)\}/);
    expect(generic).not.toBeNull();
    for (const prop of ['margin', 'padding', 'background', 'border-left', 'color', 'font-style']) {
      expect(generic[1]).toMatch(new RegExp(`(^|[;\\s])${prop}\\s*:`));
      expect(rule[1]).toMatch(new RegExp(`(^|[;\\s])${prop}\\s*:`));
    }
  });
});

describe('tm-admin.21.1: a withheld project still shows no declared lines', () => {
  it('suppresses the whole card, declared lines included, when no ST outcome was recorded', () => {
    const html = renderOutcomeWithCards({
      _id: 'sub-withheld',
      character_id: 'charA',
      published_outcome: '',
      responses: {
        project_1_title: 'The Quiet Ledger',
        project_1_outcome: 'Find out who has been skimming the tithe.',
        project_1_description: 'Quietly, through the counting house clerks.',
      },
      projects_resolved: [{ action_type: 'investigate' }],
    });
    expect(html).toContain('proj-card-withheld');
    expect(html).not.toContain('Desired Outcome:');
    expect(html).not.toContain('Approach:');
    expect(quoteOf(html)).toBeNull();
  });
});
