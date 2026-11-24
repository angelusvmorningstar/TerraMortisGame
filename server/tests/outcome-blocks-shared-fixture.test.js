/**
 * Story tm-admin.36.6 (AC 5, second half): SHARED FIXTURE for the outcome-body parser.
 *
 * The cases below are copied from TM Story's public/js/downtimes/archive-format.test.js
 * (36.6 block). TM Game and TM Story each hold their own copy of parseOutcomeBlocks /
 * renderInline / renderOutcomeBody and the copies must stay in step: if either repo's
 * tests are edited, edit the other's. Pure functions, no MongoDB.
 */
import { describe, it, expect } from 'vitest';
import {
  parseOutcomeSections, parseOutcomeBlocks, renderOutcomeBody, renderInline, esc,
} from '../../public/js/data/helpers.js';

const APRIL_2026_CARD = [
  '# Character Name',
  '*April*',
  '## Keep the docklands safe',
  '### The First Hunt',
  'You went out at dusk.',
  'The docks were quiet.',
  '',
  '### Chasing Dreams',
  'A **vivid** thing.',
  '- one',
  '- two',
].join('\n');

describe('36.6 shared fixture: outcome blocks', () => {
  it('### and deeper lines are subheadings, hashes stripped, in the parsed blocks', () => {
    expect(parseOutcomeBlocks(['### The First Hunt', '#### Deeper', '###### Deepest'])).toEqual([
      { type: 'subheading', text: 'The First Hunt' },
      { type: 'subheading', text: 'Deeper' },
      { type: 'subheading', text: 'Deepest' },
    ]);
  });

  it('the April 2026 card renders no literal hashes and real h6 subheadings', () => {
    const sec = parseOutcomeSections(APRIL_2026_CARD).find((s) => s.heading === 'Keep the docklands safe');
    expect(sec).toBeTruthy();
    const html = renderOutcomeBody(sec.lines, esc, { mode: 'lines' });
    expect(html).not.toContain('#');
    expect(html).toContain('<h6 class="dt-narrative__subheading">The First Hunt</h6>');
    expect(html).toContain('<h6 class="dt-narrative__subheading">Chasing Dreams</h6>');
    const blockHtml = renderOutcomeBody(sec.lines, esc, { mode: 'blocks', paragraphClass: 'dt-action__outcome' });
    expect(blockHtml).not.toContain('#');
  });

  it('ordinary text keeps paragraph behaviour', () => {
    expect(renderOutcomeBody(['One.', 'Two.'], esc, { mode: 'lines' })).toBe('<p>One.</p><p>Two.</p>');
    expect(renderOutcomeBody(['One.', 'Two.', '', 'Three.'], esc, { mode: 'blocks', paragraphClass: 'c' }))
      .toBe('<p class="c">One.\nTwo.</p><p class="c">Three.</p>');
    expect(renderOutcomeBody(['a  #  b', '## not at line start inside'], esc))
      .toBe('<p>a  #  b</p><p>## not at line start inside</p>');
  });

  it('**bold** becomes strong, and hostile markup is escaped', () => {
    expect(renderInline('a **b** c', esc)).toBe('a <strong>b</strong> c');
    const nasty = renderOutcomeBody([
      '### <script>alert(1)</script>',
      'x **<img src=x onerror=1>** y <b>z</b>',
      '- **<i>q</i>** & more',
      '<img src=x onerror=alert(1)>',
    ], esc);
    expect(nasty).not.toMatch(/<script|<img|<b>|<i>/);
    expect(nasty).toContain('&lt;script&gt;');
    expect(nasty).toContain('<strong>&lt;img src=x onerror=1&gt;</strong>');
    expect(nasty).toContain('<li><strong>&lt;i&gt;q&lt;/i&gt;</strong> &amp; more</li>');
    expect(nasty).toContain('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    expect(renderInline('2 ** 3', esc)).toBe('2 ** 3');
  });

  it('- and * runs become one list; a following paragraph ends it', () => {
    expect(renderOutcomeBody(['- one', '* two', 'after'], esc))
      .toBe('<ul class="dt-narrative__list"><li>one</li><li>two</li></ul><p>after</p>');
    expect(parseOutcomeBlocks(['-notalist', '--', '- ']).map((b) => b.type)).toEqual(['text']);
  });

  it('an empty ### line vanishes; CRLF parses the same as LF', () => {
    expect(parseOutcomeBlocks(['###', '### '])).toEqual([]);
    expect(parseOutcomeBlocks(['### A\r', 'text\r'])).toEqual([
      { type: 'subheading', text: 'A' }, { type: 'text', lines: ['text'] },
    ]);
  });

  it('parseOutcomeSections keeps its exact shape', () => {
    expect(parseOutcomeSections('## A\n### Sub\ntext')).toEqual([{ heading: 'A', lines: ['### Sub', 'text'] }]);
  });
});
