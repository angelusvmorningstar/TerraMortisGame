/**
 * Serialise a character into the resolved print-ready JSON shape
 * defined in schemas/print-character.schema.json.
 *
 * All values are pre-computed — the consumer never needs to derive
 * anything. Requires applyDerivedMerits(c) and loadGameXP to have
 * already run on the character.
 */

import { displayName, displayNameRaw, getWillpower, findRegentTerritory } from '../data/helpers.js';
import { freeOf } from '../data/rules-helpers.js';
import {
  getAttrEffective, getAttrBonus, skDots, skBonus, skTotal, skSpecs, skNineAgain,
  calcHealth, calcWillpowerMax, calcSize, calcSpeed, calcDefence, calcVitaeMax,
  calcCityStatus, titleStatusBonus, BP_TABLE,
} from '../data/accessors.js';
import { isInClanDisc } from '../data/accessors.js';
import { defenceMechanicalBase } from '../data/equipment-derivation.js';
import { meritLookup } from './merits.js';
import { fmtRuleStats } from '../suite/sheet-helpers.js';
import {
  calcTotalInfluence, influenceBreakdown, calcMeritInfluence, calcContactsInfluence,
  hasHoneyWithVinegar, domMeritTotal, domMeritContrib, domMeritContribSingle,
  meritEffectiveRating, ssjHerdBonus, flockHerdBonus,
} from './domain.js';
import {
  xpEarned, xpSpent, xpLeft, xpStarting, xpHumanityDrop, xpOrdeals, xpGame,
  xpSpentAttrs, xpSpentSkills, xpSpentMerits, xpSpentPowers, xpSpentSpecial,
} from './xp.js';
import { getRulesByCategory } from '../data/loader.js';
import { SKILLS_MENTAL, SKILLS_PHYSICAL, SKILLS_SOCIAL, STYLE_TAGS, CLAN_BANES } from '../data/constants.js';

const ATTR_NAMES = ['Intelligence','Wits','Resolve','Strength','Dexterity','Stamina','Presence','Manipulation','Composure'];

function skillCategory(name) {
  if (SKILLS_MENTAL.includes(name)) return 'Mental';
  if (SKILLS_PHYSICAL.includes(name)) return 'Physical';
  return 'Social';
}


/**
 * Produce the resolved print-ready JSON for a character.
 * @param {object} c - character object (post-applyDerivedMerits)
 * @param {Array} [territories] - territories array for regent derivation
 * @returns {object} Resolved character JSON matching print-character.schema.json
 */
export function serialiseForPrint(c, territories) {
  const regInfo = findRegentTerritory(territories || [], c);
  const wp = getWillpower(c);
  const hwv = hasHoneyWithVinegar(c);
  const st = c.status || {};
  const allRules = getRulesByCategory('discipline');

  // ── Identity ──
  // Use displayNameRaw() here, not displayName(). This function is called
  // only by explicit user-initiated exports (Print, PDF, JSON download) and
  // the output is either rendered into a file or serialised to disk. The
  // screen-privacy redaction in displayName() exists to hide names from
  // bystanders looking at the admin UI — it has no place in a file the user
  // is actively exporting for themselves.
  const identity = {
    name: c.name,
    displayName: displayNameRaw(c),
    player: c.player || null,
    honorific: c.honorific || null,
    moniker: c.moniker || null,
    concept: c.concept || null,
    pronouns: c.pronouns || null,
    apparent_age: c.apparent_age || null,
    clan: c.clan || null,
    bloodline: c.bloodline || null,
    covenant: c.covenant || null,
    mask: c.mask || null,
    dirge: c.dirge || null,
    court_title: c.court_title || null,
    regent_territory: regInfo?.territory || null,
  };

  // ── Stats ──
  const stats = {
    blood_potency: c.blood_potency || 1,
    humanity: c.humanity != null ? c.humanity : 7,
    health: calcHealth(c),
    willpower: calcWillpowerMax(c),
    // Issue #879 (ADR-006 D3): canonical mechanical defence is armour-adjusted
    // (no STM overlay). defenceMechanicalBase computes fresh, never reads
    // c.derived.defence which may carry an overlay-modded value at export time.
    defence: defenceMechanicalBase(c),
    speed: calcSpeed(c),
    size: calcSize(c),
    vitae_max: calcVitaeMax(c),
    status: {
      city: calcCityStatus(c),
      clan: st.clan || 0,
      covenant: st.covenant?.[c.covenant] || 0,
    },
    influence_total: calcTotalInfluence(c),
  };

  // ── Willpower conditions ──
  const willpower_conditions = {
    mask_1wp: wp.mask_1wp || '',
    mask_all: wp.mask_all || '',
    dirge_1wp: wp.dirge_1wp || '',
    dirge_all: wp.dirge_all || '',
  };

  // ── Attributes ──
  const attributes = {};
  for (const a of ATTR_NAMES) {
    const d = getAttrEffective(c, a);
    const b = getAttrBonus(c, a);
    attributes[a] = { dots: d, bonus: b, effective: d + b };
  }

  // ── Skills ──
  const ALL_SKILLS = [...SKILLS_MENTAL, ...SKILLS_PHYSICAL, ...SKILLS_SOCIAL];
  const skills = [];
  for (const s of ALL_SKILLS) {
    const effective = skTotal(c, s);
    const specs = skSpecs(c, s);
    const naStored = skNineAgain(c, s);
    const naPT = c._pt_nine_again_skills?.has(s) || false;
    const naMCI = c._mci_dot3_skills?.has(s) || false;
    const naOHM = c._ohm_nine_again_skills?.has(s) || false;
    const nineAgain = naStored || naPT || naMCI || naOHM;
    if (!effective && !specs.length) continue;
    const baseDots = skDots(c, s);
    const bonus = skBonus(c, s);
    const ptBonus = c._pt_dot4_bonus_skills?.has(s) && (baseDots + bonus) < 5 ? 1 : 0;
    const mciBonus = c._mci_dot3_skills?.has(s) && (baseDots + bonus) < 5 ? 1 : 0;
    const sources = [];
    if (naStored) sources.push('stored');
    if (naPT) sources.push('PT');
    if (naMCI) sources.push('MCI');
    if (naOHM) sources.push('OHM');
    skills.push({
      name: s,
      category: skillCategory(s),
      dots: baseDots,
      bonus,
      pt_bonus: ptBonus,
      mci_bonus: mciBonus,
      effective,
      nine_again: nineAgain,
      nine_again_sources: sources,
      specialisations: specs,
    });
  }

  // ── Disciplines ──
  const disciplines = [];
  for (const [name, v] of Object.entries(c.disciplines || {})) {
    const dots = v?.dots || 0;
    if (!dots) continue;
    const fromRules = allRules
      .filter(r => r.parent === name && r.rank != null && r.rank <= dots)
      .sort((a, b) => a.rank - b.rank);
    const powers = fromRules.map(r => ({
      rank: r.rank,
      name: r.name,
      stats: fmtRuleStats(r),
      effect: r.description || '',
      cost: r.cost || null,
      pool: r.pool ? [r.pool.attr, r.pool.skill].filter(Boolean).join(' + ') || null : null,
      action: r.action || null,
      duration: r.duration || null,
      resistance: r.resistance || null,
    }));
    disciplines.push({
      name,
      dots,
      in_clan: isInClanDisc(c, name),
      powers,
    });
  }
  disciplines.sort((a, b) => a.name.localeCompare(b.name));

  // ── Merits ──
  // Contacts gets special handling: raw character data may have multiple
  // Contacts merit entries, each contributing dots and spheres. The UI
  // aggregates them into a single display row (see editor/sheet.js line
  // 709) — we mirror that here so the PDF renderer sees a clean shape.
  const rawMerits = c.merits || [];
  const contactsEntries = rawMerits.filter(m => m.category === 'influence' && m.name === 'Contacts');

  // Non-Contacts merits pass through normally
  const normalMerits = rawMerits.filter(m => !(m.category === 'influence' && m.name === 'Contacts')).map(m => {
    let effectiveRating = m.rating || 0;
    let ownDots = effectiveRating;
    const bonuses = [];
    if (m.category === 'domain') {
      // meritEffectiveRating handles: multi-instance SP/FG (per-instance total),
      // cap for Haven/MG (capped at attached Safe Place), Herd (SSJ+Flock), shared pools.
      effectiveRating = meritEffectiveRating(c, m);
      ownDots = domMeritContribSingle(c, m);
    }
    if (m.name === 'Herd') {
      const ssj = ssjHerdBonus(c);
      const flock = flockHerdBonus(c);
      if (ssj) { effectiveRating += ssj; bonuses.push('+' + ssj + ' SSJ'); }
      if (flock) { effectiveRating += flock; bonuses.push('+' + flock + ' Flock'); }
    }
    let inf = 0;
    if (m.category === 'influence') inf = calcMeritInfluence(c, m, hwv);
    const lookup = meritLookup(m.name);
    return {
      name: m.name,
      category: m.category,
      effective_rating: effectiveRating,
      own_dots: ownDots,
      qualifier: m.qualifier || null,
      area: m.area || null,
      spheres: Array.isArray(m.spheres) ? m.spheres.slice() : null,
      granted_by: m.granted_by || null,
      shared_with: m.shared_with || [],
      is_shared: (m.shared_with || []).length > 0,
      bonuses,
      cult_name: m.cult_name || null,
      asset_skills: m.asset_skills || [],
      influence: inf,
      description: (lookup && lookup.desc) || null,
    };
  });

  // Build the aggregated Contacts entry (only if the character has any).
  const merits = normalMerits;
  if (contactsEntries.length) {
    const totalRating = Math.min(5, contactsEntries.reduce((s, m) => s + (m.rating || 0), 0));
    const allSpheres = [];
    contactsEntries.forEach(m => {
      if (Array.isArray(m.spheres) && m.spheres.length) {
        allSpheres.push(...m.spheres);
      } else if (m.area) {
        allSpheres.push(m.area.trim());
      } else if (m.qualifier) {
        allSpheres.push(...m.qualifier.split(/,\s*/).filter(Boolean));
      }
    });
    const uniqueSpheres = [...new Set(allSpheres.filter(Boolean))];
    const lookup = meritLookup('Contacts');
    merits.push({
      name: 'Contacts',
      category: 'influence',
      effective_rating: totalRating,
      own_dots: totalRating,
      qualifier: null,
      area: null,
      spheres: uniqueSpheres,
      granted_by: null,
      shared_with: [],
      is_shared: false,
      bonuses: [],
      cult_name: null,
      asset_skills: [],
      influence: 0,
      description: (lookup && lookup.desc) || null,
    });
  }

  // ── Devotions ──
  const devotions = (c.powers || [])
    .filter(p => p.category === 'devotion')
    .map(p => ({
      name: p.name,
      xp_cost: p.xp || 0,
      prereqs: p.stats || '',
      effect: p.effect || '',
    }));

  // ── Rites ──
  const rites = (c.powers || [])
    .filter(p => p.category === 'rite')
    .map(p => ({
      name: p.name,
      tradition: p.tradition,
      level: p.level || 1,
      free: !!p.free,
      xp_cost: p.free ? 0 : (p.level >= 4 ? 2 : 1),
    }));

  // ── Fighting styles ──
  const fighting_styles = (c.fighting_styles || []).map(fs => ({
    name: fs.name,
    dots: (fs.cp || 0) + (fs.free || 0) + freeOf(fs, 'mci') + freeOf(fs, 'ots') + (fs.xp || 0),
    tags: STYLE_TAGS[fs.name] || [],
    picks: fs.picks || [],
  }));

  // ── Touchstones ──
  const touchstones = (c.touchstones || []).map(t => ({
    humanity: t.humanity,
    name: t.name,
    desc: t.desc || null,
  }));

  // ── Banes ──
  const allBanes = c.banes || [];
  const clanCurse = CLAN_BANES[c.clan];
  const banes = allBanes.map(b => ({
    name: b.name,
    effect: b.effect || '',
    is_curse: !!(clanCurse && b.name && b.name.toLowerCase().includes('curse')),
  }));

  // ── XP ──
  const xp = {
    earned: xpEarned(c),
    spent: xpSpent(c),
    remaining: xpLeft(c),
    breakdown: {
      starting: xpStarting(c),
      humanity_drops: xpHumanityDrop(c),
      ordeals: xpOrdeals(c),
      game: xpGame(c),
      spent_attributes: xpSpentAttrs(c),
      spent_skills: xpSpentSkills(c),
      spent_disciplines: xpSpentPowers(c),
      spent_merits: xpSpentMerits(c),
      spent_devotions: 0, // included in spent_special
      spent_special: xpSpentSpecial(c),
    },
  };

  // ── Influence breakdown ──
  const influence_breakdown = influenceBreakdown(c);

  return {
    identity,
    stats,
    willpower_conditions,
    attributes,
    skills,
    disciplines,
    merits,
    devotions,
    rites,
    fighting_styles,
    touchstones,
    banes,
    xp,
    influence_breakdown,
  };
}

/**
 * Build the `print_meta` block consumed by the PDF renderer.
 *
 * Kept as a separate export so `serialiseForPrint()` stays pure (no `Date.now`
 * in its call tree) and the PDF button call site owns "render time" concerns.
 * Callers merge the returned object into the serialiseForPrint output before
 * passing to the renderer:
 *
 *     const data = serialiseForPrint(c, territories);
 *     data.print_meta = buildPrintMeta(c, data);
 *     await render({ data, ... });
 *
 * @param {object} c - character object
 * @param {object} serialised - return value of serialiseForPrint(c)
 * @returns {object} print_meta block
 */
export function buildPrintMeta(c, serialised) {
  const bp = c.blood_potency || 0;
  const bpRow = BP_TABLE[bp] || BP_TABLE[1];

  // BP feed tier maps to a human-readable "Can feed from" value.
  // BP 0–2 feed from animals, 3–4 from humans, 5+ only from kindred.
  const FEED_LABEL = {
    animal:  'Animals',
    human:   'Humans',
    kindred: 'Kindred',
  };
  const feedSources = [FEED_LABEL[bpRow.feed] || 'Animals'];

  return {
    printed_date: formatDDMMMYY(new Date()),
    xp_display: `${serialised.xp.remaining} / ${serialised.xp.earned}`,
    clan_key: serialised.identity.clan || null,
    covenant_key: serialised.identity.covenant || null,
    feed_sources: feedSources,
    vitae_per_turn: bpRow.per_turn,
  };
}

function formatDDMMMYY(d) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dd = String(d.getDate()).padStart(2, '0');
  const mmm = months[d.getMonth()];
  const yy = String(d.getFullYear() % 100).padStart(2, '0');
  return `${dd}-${mmm}-${yy}`;
}

/**
 * Export the resolved character JSON as a downloadable file.
 */
export function exportCharacterJSON(c, territories) {
  const data = serialiseForPrint(c, territories);
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (c.name || 'character').replace(/[^a-zA-Z0-9]/g, '_') + '_print.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
