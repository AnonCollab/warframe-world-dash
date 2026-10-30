'use strict';
/*
 * WorldDash — Warframe world state dashboard.
 *
 * Architecture (rearrangeability first):
 * - TABS is a plain list of { id, label }.
 * - SECTIONS is a plain ordered list of { id, tab, title, span?, render, mount? }.
 *   `tab` is just a string key into TABS. Moving a section to another tab =
 *   editing its one `tab:` value. Reordering = moving its entry in the array.
 *   `span` is 1 (default) or 2 grid columns on wide screens; it may also be a
 *   function of the data, resolved at render time (used by the Baro section).
 * - The tab bar, panels, and section cards are all generated from these two
 *   lists; index.html holds no per-section markup.
 * - Every render(data) is self-contained: it reads only the worldstate object,
 *   returns only its own section's HTML, and knows nothing about siblings or
 *   about which tab it lives on. Filters owned by a section render inside the
 *   section and are wired in its mount() hook, scoped to its own element.
 * - Countdowns are <span data-expiry="..."> elements; one global ticker
 *   updates them all, wherever they are.
 */

/* global translateWorldState */

const FEED_URL = 'https://wfws.tacusinmemo.workers.dev/';
const STATICS_URL = 'static-data.json';
const REFERENCE_URL = 'reference-data.json';
const ICON_CDN = 'https://cdn.warframestat.us/img/';
const REFRESH_MS = 5 * 60 * 1000;

/* ============================== helpers ============================== */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// Numbers and numeric strings both get thousands separators ("50000" from
// the feed renders as "50,000"); anything else is escaped as plain text.
const num = (x) => {
  if (typeof x === 'number') return x.toLocaleString('en-US');
  if (typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x.trim())) return Number(x).toLocaleString('en-US');
  return esc(x);
};

// "Lv 50" when a range's ends are identical, "Lv 50–60" otherwise.
const lvlRange = (min, max) => (min == null ? ''
  : (max == null || Number(max) === Number(min) ? `Lv ${min}` : `Lv ${min}–${max}`));

function fmtDur(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return 'ended';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return m < 10 ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

// Countdown span; the global ticker fills it from data-expiry.
const timer = (expiry, prefix = '') => expiry
  ? `<span class="timer" data-expiry="${esc(expiry)}" data-prefix="${esc(prefix)}">…</span>`
  : '';

const fmtDate = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || new Date(t).getFullYear() < 2000) return '';
  return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const empty = (msg) => `<p class="empty">${esc(msg)}</p>`;
const row = (label, value) => `<div class="row"><span class="label">${esc(label)}</span><span class="value">${value}</span></div>`;
// Stacked variant for narrow cards: small-caps label above a full-width value.
const rowStacked = (label, value) => `<div class="row stacked"><span class="label">${esc(label)}</span><span class="value">${value}</span></div>`;

// An <img> that removes itself if the source fails, so a broken icon never
// shows the browser's broken-image glyph. Empty src -> no element at all.
const imgTag = (src, extra = '') => (src
  ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()"${extra}>`
  : '');

// Full date with year, for durations too long to read as a countdown.
const fmtDateYear = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || new Date(t).getFullYear() < 2000) return '';
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const chips = (items) => `<div class="chips">${items.map((i) => `<span class="chip">${esc(i)}</span>`).join('')}</div>`;
const bar = (pct, cls = '') => {
  const p = Math.max(0, Math.min(100, Math.abs(Number(pct) || 0)));
  return `<div class="bar ${cls}"><div style="width:${p.toFixed(1)}%"></div></div>`;
};

// "MPVNidusPrimeSinglePack" / "/Lotus/.../BioComponent" -> "Nidus Prime Single Pack" / "Bio Component"
function pathName(p) {
  if (!p) return '';
  let tail = String(p).split('/').filter(Boolean).pop() || String(p);
  tail = tail.replace(/\.(level|json)$/i, '').replace(/^MPV/, '');
  return tail
    // Split a word/digit boundary ("Intermission16" -> "Intermission 16")
    // only after a 2+ letter run, so short codes like "T1" stay intact.
    .replace(/([a-zA-Z]{2})(\d)/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => (w.length >= 3 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w))
    .join(' ');
}

// Clean a feed enum key: "CT_LAB" -> "Lab", "DT_EXCAVATION" -> "Excavation"
function cleanKey(key, stripPrefixes = ['CT', 'DT', 'MT', 'FC']) {
  if (!key) return '';
  let s = String(key);
  if (s.includes(' ')) s = s.replace(/ /g, ''); // undo the parser's spaced-letter mangling ("C T_ L A B")
  for (const p of stripPrefixes) if (s.startsWith(p + '_')) { s = s.slice(p.length + 1); break; }
  return pathName(s.replace(/_/g, ' '));
}

// Some parser names arrive with every letter spaced out ("M P V Nidus...").
// Detect that shape so callers can fall back to the uniqueName-derived name.
const isMangled = (s) => typeof s === 'string' && /(^|\s)[A-Za-z](\s[A-Za-z]){2,}/.test(s);

function displayName(name, uniqueName) {
  if (name && !isMangled(name)) return name;
  const fromPath = pathName(uniqueName);
  return fromPath || name || '';
}

const humanizeTag = (tag) => pathName(String(tag || '').replace(/Syndicate$/, ''));

// The feed sometimes names the trader by event id ("EvilBaroWeek3") instead
// of by character; an id-like string (no spaces, mixed case/digits) is not a
// display name — the Void Trader is Baro Ki'Teer.
function traderDisplayName(character) {
  const name = displayName(character, '');
  if (name && !/\s/.test(name) && /[a-z][A-Z]|\d/.test(name)) return "Baro Ki'Teer";
  return name;
}

// One reward object ({credits, items[], countedItems[], thumbnail}) -> HTML lines.
// The feed puts the same items in BOTH items[] (names only) and countedItems[]
// (count + uniqueName + type), so countedItems wins when present and every
// name is emitted at most once per reward object.
function rewardHTML(reward) {
  if (!reward) return '';
  const out = [];
  if (reward.credits) out.push(`<div class="reward-line"><span>${num(reward.credits)} credits</span></div>`);
  const seen = new Set();
  const push = (name, count, img) => {
    const key = String(name || '').toLowerCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    out.push(`<div class="reward-line">${img || ''}<span>${count > 1 ? `${num(count)} × ` : ''}${esc(name)}</span></div>`);
  };
  const counted = reward.countedItems || [];
  counted.forEach((ci, i) => push(
    displayName(ci.type || ci.key, ci.uniqueName), ci.count, i === 0 ? imgTag(reward.thumbnail) : ''));
  (reward.items || []).forEach((it, i) => push(it, 1, !counted.length && i === 0 ? imgTag(reward.thumbnail) : ''));
  return out.join('');
}

// Icon <img> for trader/market entries. Feed thumbnail wins; otherwise the
// element is tagged for a sparing items-API lookup after render.
function itemIcon(thumb, uniqueName) {
  if (thumb) return imgTag(thumb);
  if (uniqueName) return `<img data-lookup="${esc(uniqueName)}" alt="" loading="lazy" onerror="this.remove()" hidden>`;
  return '';
}

/* ============================== renderers ============================== */
/* Each takes the full worldstate object and returns its section's HTML.   */

function rCycles(d) {
  const out = [];
  const cyc = (label, c, stateText) => {
    if (!c) return;
    out.push(rowStacked(label, `${esc(stateText)} · ${timer(c.expiry, 'ends in ')}`));
  };
  if (d.earthCycle) cyc('Earth', d.earthCycle, d.earthCycle.isDay ? 'Day' : 'Night');
  if (d.cetusCycle) cyc('Cetus', d.cetusCycle, d.cetusCycle.isDay ? 'Day' : 'Night');
  if (d.vallisCycle) cyc('Orb Vallis', d.vallisCycle, d.vallisCycle.isWarm ? 'Warm' : 'Cold');
  if (d.cambionCycle) cyc('Cambion Drift', d.cambionCycle, d.cambionCycle.state === 'fass' ? 'Fass' : 'Vome');
  if (d.zarimanCycle) cyc('Zariman', d.zarimanCycle, d.zarimanCycle.isCorpus ? 'Corpus' : 'Grineer');
  if (d.duviriCycle) cyc('Duviri mood', d.duviriCycle, pathName(d.duviriCycle.state));
  return out.length ? out.join('') : empty('No cycle data in this feed snapshot.');
}

function rConstruction(d) {
  const c = d.constructionProgress;
  if (!c) return empty('No construction data in this feed snapshot.');
  const f = parseFloat(c.fomorianProgress) || 0;
  const r = parseFloat(c.razorbackProgress) || 0;
  return rowStacked('Balor Fomorian', `${f.toFixed(2)}%`) + bar(f, 'fomorian')
    + rowStacked('Razorback', `${r.toFixed(2)}%`) + bar(r, 'razorback')
    + `<p class="note">Construction progress toward the next Fomorian / Razorback event.</p>`;
}

function rOverviewTraders(d) {
  const out = [];
  const vt = d.voidTrader;
  if (vt) {
    const now = Date.now();
    const act = Date.parse(vt.activation), exp = Date.parse(vt.expiry);
    const who = `${esc(traderDisplayName(vt.character))} — ${esc(vt.location || '')}`;
    if (act > now) out.push(rowStacked('Void Trader', `${who} · ${timer(vt.activation, 'arrives in ')}`));
    else if (exp > now) out.push(rowStacked('Void Trader', `${who} · ${timer(vt.expiry, 'leaves in ')}`));
  }
  const vz = d.vaultTrader;
  if (vz) out.push(rowStacked('Varzia (Prime Resurgence)', `${esc(vz.location || '')} · ${timer(vz.expiry, 'rotation ends in ')}`));
  const deal = (d.dailyDeals || [])[0];
  if (deal) out.push(rowStacked('Darvo deal', `${esc(displayName(deal.item, deal.uniqueName))} — ${num(deal.salePrice)} plat${deal.discount ? ` (−${deal.discount}%)` : ''} · ${timer(deal.expiry, 'ends in ')}`));
  return out.length ? out.join('') : empty('No trader information in this feed snapshot.');
}

function rOverviewDaily(d) {
  const out = [];
  if (d.sortie && d.sortie.boss) out.push(rowStacked('Sortie', `${esc(d.sortie.boss)} (${esc(d.sortie.faction || '')}) · ${timer(d.sortie.expiry, 'ends in ')}`));
  if (d.archonHunt && d.archonHunt.boss) out.push(rowStacked('Archon Hunt', `${esc(d.archonHunt.boss)} · ${timer(d.archonHunt.expiry, 'ends in ')}`));
  if (d.steelPath && d.steelPath.currentReward) out.push(rowStacked('Steel Path (Teshin)', `${esc(d.steelPath.currentReward.name)} — ${num(d.steelPath.currentReward.cost)} Steel Essence`));
  if (d.simaris && d.simaris.target) out.push(rowStacked('Simaris target', `${esc(d.simaris.target)}${d.simaris.isTargetActive ? '' : ' (not currently active)'}`));
  const arb = d.arbitration;
  out.push(rowStacked('Arbitration', isArbStub(arb) ? 'Data unavailable from source' : `${esc(arb.node)} — ${esc(arb.type)}`));
  return out.join('');
}

function isArbStub(a) {
  if (!a) return true;
  return a.node === 'SolNode000' || a.nodeKey === 'SolNode000' || a.typeKey === 'Unknown'
    || (a.expired && Date.parse(a.activation) < Date.parse('2000-01-01'));
}

function rAlerts(d) {
  const list = (d.alerts || []).filter((a) => Date.parse(a.expiry) > Date.now() - 60000);
  if (!list.length) return empty('No active alerts.');
  return `<div class="entries-2col">${list.map((a) => {
    const m = a.mission || {};
    const flags = [m.nightmare ? 'Nightmare' : '', m.archwingRequired ? 'Archwing' : ''].filter(Boolean).join(' · ');
    const lvl = m.minEnemyLevel != null ? ` · ${lvlRange(m.minEnemyLevel, m.maxEnemyLevel)}` : '';
    return `<div class="entry">
      <div class="entry-head"><span class="entry-title">${esc(m.node || 'Alert')}</span>${timer(a.expiry, 'ends in ')}</div>
      <div class="entry-sub">${esc(m.type || '')} · ${esc(m.faction || '')}${lvl}${flags ? ` · ${esc(flags)}` : ''}</div>
      ${rewardHTML(m.reward)}
    </div>`;
  }).join('')}</div>`;
}

function rEvents(d) {
  const list = d.events || [];
  if (!list.length) return empty('No active events.');
  return `<div class="entries-2col">${list.map((e) => {
    const parts = [];
    parts.push(`<div class="entry"><div class="entry-head"><span class="entry-title">${esc(e.description || e.tag || 'Event')}</span>${timer(e.expiry, 'ends in ')}</div>`);
    if (e.node) parts.push(`<div class="entry-sub">${esc(e.node)}</div>`);
    if (e.maximumScore > 0) parts.push(row('Progress', `${num(e.currentScore || 0)} / ${num(e.maximumScore)}`) + bar(100 * (e.currentScore || 0) / e.maximumScore));
    else if (e.currentScore > 0) parts.push(row('Score', num(e.currentScore)));
    if (typeof e.health === 'number') parts.push(row('Health', `${e.health.toFixed(1)}%`) + bar(e.health));
    (e.rewards || []).forEach((rw) => { parts.push(rewardHTML(rw)); });
    (e.interimSteps || []).forEach((s, i) => {
      const label = s.description || s.type || `Interim step ${i + 1}`;
      parts.push(`<div class="entry-sub">Step: ${esc(label)}${s.count ? ` — ${num(s.count)}` : ''}</div>`);
      if (s.reward) parts.push(rewardHTML(s.reward));
    });
    if ((e.jobs || []).length) parts.push(`<div class="entry-sub">${e.jobs.length} event mission(s)</div>`);
    parts.push('</div>');
    return parts.join('');
  }).join('')}</div>`;
}

function rNews(d) {
  const list = [...(d.news || [])].sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  if (!list.length) return empty('No news in this feed snapshot.');
  return list.map((n) => {
    const flags = [n.update ? 'Update' : '', n.stream ? 'Stream' : '', n.primeAccess ? 'Prime Access' : '', n.priority ? 'Priority' : ''].filter(Boolean);
    const segments = [fmtDate(n.date), ...flags].filter(Boolean);
    return `<div class="news-item">
      <a href="${esc(n.link || '#')}" target="_blank" rel="noopener">${esc(n.message || '')}</a>
      ${segments.length ? `<div class="date">${segments.map(esc).join(' · ')}</div>` : ''}
    </div>`;
  }).join('');
}

/* Fissures carry their own filter state and controls, so the section moves
   as one unit. */
const fissureFilter = { tier: '', type: '' };

function fissureRows(list) {
  if (!list.length) return empty('None matching.');
  return list.map((f) => `<div class="entry">
    <div class="entry-head"><span class="entry-title">${esc(f.node)}</span>${timer(f.expiry, 'ends in ')}</div>
    <div class="entry-sub">${esc(f.missionType)} (${esc(f.tier)}) · ${esc(f.enemy)}</div>
  </div>`).join('');
}

function fissureGroups(d) {
  const now = Date.now();
  const list = (d.fissures || []).filter((f) => Date.parse(f.expiry) > now
    && (!fissureFilter.tier || f.tier === fissureFilter.tier)
    && (!fissureFilter.type || f.missionType === fissureFilter.type));
  const byExpiry = (a, b) => Date.parse(a.expiry) - Date.parse(b.expiry);
  const group = (title, arr) => `<h3 class="sticky-sub">${title}</h3><div class="entries-2col">${fissureRows([...arr].sort(byExpiry))}</div>`;
  return group('Normal', list.filter((f) => !f.isHard && !f.isStorm))
    + group('Steel Path', list.filter((f) => f.isHard && !f.isStorm))
    + group('Void Storms', list.filter((f) => f.isStorm));
}

function rFissures(d) {
  const tiers = [...new Set((d.fissures || []).map((f) => f.tier))].sort();
  const types = [...new Set((d.fissures || []).map((f) => f.missionType))].sort();
  const opts = (vals, sel) => `<option value="">All</option>` + vals.map((v) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(v)}</option>`).join('');
  return `<div class="filters">
      <label>Tier <select data-f="tier">${opts(tiers, fissureFilter.tier)}</select></label>
      <label>Mission type <select data-f="type">${opts(types, fissureFilter.type)}</select></label>
    </div>
    <div class="fissure-list">${fissureGroups(d)}</div>`;
}

function mountFissures(el, d) {
  el.querySelectorAll('select[data-f]').forEach((sel) => {
    sel.addEventListener('change', () => {
      fissureFilter[sel.dataset.f] = sel.value;
      el.querySelector('.fissure-list').innerHTML = fissureGroups(d);
      tickTimers();
    });
  });
}

function invasionETA(inv) {
  const elapsed = Date.now() - Date.parse(inv.activation);
  const pct = Math.abs(Number(inv.completion) || 0);
  if (inv.completed || pct <= 0.5 || elapsed < 120000 || pct >= 100) return '';
  const eta = elapsed * (100 - pct) / pct;
  return ` · estimated ~${fmtDur(eta)} left`;
}

function rInvasions(d) {
  const all = d.invasions || [];
  if (!all.length) return empty('No active invasions.');
  const entry = (inv) => {
    const pct = Math.abs(Number(inv.completion) || 0);
    const atk = inv.attacker || {}, def = inv.defender || {};
    const payBlock = (label, reward) => `<div><div class="entry-sub">${esc(label)}</div>${rewardHTML(reward)}</div>`;
    const rewardBlock = inv.vsInfestation
      ? payBlock('Battle pay', def.reward)
      : `<div class="pay-cols">${payBlock(`${atk.faction || 'Attacker'} battle pay`, atk.reward)}${payBlock(`${def.faction || 'Defender'} battle pay`, def.reward)}</div>`;
    // A completed invasion's feed "completion" is not a progress measure
    // (it reads 0.0% or 100.1%), so finished entries show no bar or %.
    const progress = inv.completed ? ''
      : `<div class="bar-line">${bar(pct)}<span class="entry-sub">${Math.min(100, pct).toFixed(1)}%${invasionETA(inv)}</span></div>`;
    return `<div class="entry">
      <div class="entry-head"><span class="entry-title">${esc(inv.node)}</span><span>${inv.completed ? '<span class="chip">Completed</span>' : timer(inv.expiry || '', '')}</span></div>
      <div class="entry-sub">${esc(inv.desc || '')}${inv.vsInfestation ? '' : ` · ${esc(atk.faction || '')} vs ${esc(def.faction || '')}`}</div>
      ${progress}
      ${rewardBlock}
    </div>`;
  };
  // Active invasions first, nearest to completion first; completed ones
  // collapse into a disclosure at the end of the list.
  const active = all.filter((i) => !i.completed)
    .sort((a, b) => Math.abs(Number(b.completion) || 0) - Math.abs(Number(a.completion) || 0));
  const done = all.filter((i) => i.completed);
  let out = active.length
    ? `<div class="entries-2col">${active.map(entry).join('')}</div>`
    : empty('No active invasions.');
  if (done.length) out += `<details class="pool"><summary>Completed (${done.length})</summary>${done.map(entry).join('')}</details>`;
  return out;
}

function rSortie(d) {
  const s = d.sortie;
  if (!s || !s.boss) return empty('No sortie in this feed snapshot.');
  const variants = (s.variants || []).map((v) => `<div class="entry">
      <div class="entry-head"><span class="entry-title">${esc(v.node)}</span><span class="entry-sub">${esc(v.missionType)}</span></div>
      <div class="entry-sub">${esc(v.modifier)}</div>
      ${v.modifierDescription ? `<p class="desc">${esc(v.modifierDescription)}</p>` : ''}
    </div>`).join('');
  return `<div class="entry-head"><span class="entry-title">${esc(s.boss)} (${esc(s.faction || '')})</span>${timer(s.expiry, 'ends in ')}</div>
    <div class="entry-sub">Reward pool: ${esc(s.rewardPool || 'Sortie Rewards')}</div>${variants}`;
}

function rArchon(d) {
  const a = d.archonHunt;
  if (!a || !a.boss) return empty('No Archon Hunt in this feed snapshot.');
  const missions = (a.missions || []).map((m) => `<div class="entry">
      <div class="entry-head"><span class="entry-title">${esc(m.node)}</span><span class="entry-sub">${esc(m.type)}</span></div>
      ${m.nightmare ? '<div class="entry-sub">Nightmare</div>' : ''}
    </div>`).join('');
  return `<div class="entry-head"><span class="entry-title">${esc(a.boss)}</span>${timer(a.expiry, 'ends in ')}</div>
    <div class="entry-sub">Reward pool: ${esc(a.rewardPool || 'Archon Sortie Rewards')}</div>${missions}`;
}

function rArbitration(d) {
  const a = d.arbitration;
  if (isArbStub(a)) {
    return empty('Arbitration data unavailable from source.')
      + `<p class="note">Arbitrations are not part of the world state feed; the separate upstream arbitration feed is currently down, so no mission can be shown. This section will populate itself if that feed returns.</p>`;
  }
  return `<div class="entry">
    <div class="entry-head"><span class="entry-title">${esc(a.node)}</span>${timer(a.expiry, 'ends in ')}</div>
    <div class="entry-sub">${esc(a.type)} · ${esc(a.enemy)}</div>
  </div>`;
}

function rNightwave(d) {
  const nw = d.nightwave;
  if (!nw) return empty('No Nightwave data in this feed snapshot.');
  const head = `<div class="entry-head"><span class="entry-title">${esc(humanizeTag(nw.tag)) || 'Nightwave'}</span>${timer(nw.expiry, 'season ends in ')}</div>
    <div class="entry-sub">Season ${esc(nw.season ?? '')}${nw.phase != null ? ` · Phase ${esc(nw.phase)}` : ''}</div>`;
  // One timer per group: the subhead carries the group's most common expiry
  // (the shared reset); an act expiring at a different time keeps its own.
  const group = (title, acts, emptyMsg) => {
    if (!acts.length) return `<h3>${title}</h3>${empty(emptyMsg)}`;
    const counts = new Map();
    acts.forEach((c) => { if (c.expiry) counts.set(c.expiry, (counts.get(c.expiry) || 0) + 1); });
    let groupExpiry = '', best = 0;
    for (const [exp, n] of counts) {
      if (n > best || (n === best && exp < groupExpiry)) { best = n; groupExpiry = exp; }
    }
    const act = (c) => `<div class="entry">
      <div class="entry-head"><span class="entry-title">${esc(c.title || c.desc || '')}</span><span class="entry-sub">${num(c.reputation)} standing</span></div>
      <div class="entry-sub">${esc(c.desc || '')}</div>
      ${c.expiry && c.expiry !== groupExpiry ? `<div class="entry-sub">${timer(c.expiry, 'ends in ')}</div>` : ''}
    </div>`;
    return `<h3>${title}${groupExpiry ? ` — ${timer(groupExpiry, 'ends in ')}` : ''}</h3>${acts.map(act).join('')}`;
  };
  const all = nw.activeChallenges || [];
  const daily = all.filter((c) => c.isDaily);
  const elite = all.filter((c) => !c.isDaily && c.isElite);
  const weekly = all.filter((c) => !c.isDaily && !c.isElite);
  return head
    + group('Daily', daily, 'No daily acts.')
    + group('Weekly', weekly, 'No weekly acts.')
    + group('Elite weekly', elite, 'No elite acts.');
}

function rCircuit(d) {
  const c = d.duviriCycle;
  if (!c || !(c.choices || []).length) return empty('No Circuit rotation in this feed snapshot.');
  const groups = c.choices.map((g) => {
    const label = g.categoryKey === 'EXC_HARD' ? 'Steel Path Circuit — weapons' : 'Normal Circuit — Warframes';
    return `<h3>${label}</h3>${chips(g.choices || [])}`;
  }).join('');
  return `<div class="entry-head"><span class="entry-title">Duviri mood: ${esc(pathName(c.state))}</span>${timer(c.expiry, 'rotation ends in ')}</div>` + groups;
}

function rSteelPath(d) {
  const sp = d.steelPath;
  if (!sp) return empty('No Steel Path data in this feed snapshot.');
  const out = [];
  if (sp.currentReward) out.push(rowStacked('Current Teshin reward', `${esc(sp.currentReward.name)} — ${num(sp.currentReward.cost)} Steel Essence`));
  out.push(`<div class="entry-sub">${timer(sp.expiry, 'rotation ends in ')}</div>`);
  if ((sp.rotation || []).length) out.push(`<h3>Rotation</h3>` + chips(sp.rotation.map((r) => `${r.name} (${r.cost})`)));
  if ((sp.evergreens || []).length) out.push(`<details class="pool"><summary>Evergreen offerings (${sp.evergreens.length})</summary>${chips(sp.evergreens.map((r) => `${r.name} (${r.cost})`))}</details>`);
  if (sp.incursions) out.push(row('Incursions window', `${fmtDate(sp.incursions.activation)} → ${fmtDate(sp.incursions.expiry)}`));
  return out.join('');
}

function rArchimedea(d) {
  const list = d.archimedeas || [];
  if (!list.length) return empty('No Archimedea rotation in this feed snapshot.');
  return list.map((a) => {
    const label = cleanKey(a.typeKey) || displayName(a.type, '');
    const missions = (a.missions || []).map((m) => `<div class="entry">
        <div class="entry-head"><span class="entry-title">${esc(m.missionType)}</span><span class="entry-sub">${esc(m.faction || '')}</span></div>
        ${m.deviation ? `<div class="entry-sub">Deviation: ${esc(m.deviation.name || m.deviation.key || '')}</div>` : ''}
        ${(m.risks || []).length ? `<div class="entry-sub">Risks: ${m.risks.map((r) => esc(r.name || r.key || '')).join(', ')}</div>` : ''}
      </div>`).join('');
    const mods = (a.personalModifiers || []).map((p) => p.name || p.key).filter(Boolean);
    return `<div class="entry">
      <div class="entry-head"><span class="entry-title">Archimedea — ${esc(label)}</span>${timer(a.expiry, 'ends in ')}</div>
      ${mods.length ? `<div class="entry-sub">Personal modifiers: ${mods.map(esc).join(', ')}</div>` : ''}
      ${missions}
    </div>`;
  }).join('');
}

function rDescendia(d) {
  const dz = d.descendia;
  if (!dz || !(dz.challenges || []).length) return empty('No Descendia rotation in this feed snapshot.');
  const rows = dz.challenges.map((c) => {
    const auras = (c.auras || []).map((x) => displayName(x.name, x.uniqueName)).filter(Boolean).join(', ');
    return `<tr><td class="num">${esc(c.index)}</td><td>${esc(cleanKey(c.typeKey))}</td><td>${esc(displayName(c.challenge, ''))}</td><td>${auras ? esc(auras) : '—'}</td></tr>`;
  }).join('');
  return `<div class="entry-head"><span class="entry-title">Descendia — ${dz.challenges.length} floors</span>${timer(dz.expiry, 'rotation ends in ')}</div>
    <div class="table-wrap"><table><thead><tr><th class="num">#</th><th>Type</th><th>Challenge</th><th>Auras</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function rCalendar(d) {
  const cal = d.calendar;
  if (!cal || !(cal.days || []).length) return empty('No 1999 calendar in this feed snapshot.');
  const head = `<div class="entry-head"><span class="entry-title">1999 Calendar — ${esc(cal.season || '')}${cal.yearIteration ? `, year ${esc(cal.yearIteration)}` : ''}</span>${timer(cal.expiry, 'week ends in ')}</div>`;
  let lastMonth = '';
  // Days whose events list is empty carry nothing in any other field
  // (checked against the feed shape: a day is only {date, events}), so
  // they are omitted rather than rendered as a bare "—" row.
  const eventDays = [...cal.days].filter((day) => (day.events || []).length);
  if (!eventDays.length) return head + empty('No calendar events in this feed snapshot.');
  const days = eventDays.sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0)).map((day) => {
    const t = Date.parse(day.date);
    const month = Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }) : '';
    const monthHead = month && month !== lastMonth ? `<h3>${esc(month)}</h3>` : '';
    if (month) lastMonth = month;
    const label = Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
    const evs = (day.events || []).map((ev) => {
      if (ev.challenge) return `<span class="chip">${esc(ev.type || 'To Do')}: ${esc(ev.challenge.title || '')}</span>`;
      if (ev.upgrade) return `<span class="chip">Override: ${esc(ev.upgrade.title || '')}</span>`;
      if (ev.reward) return `<span class="chip">${esc(ev.type || 'Reward')}: ${esc(displayName(ev.reward, ev.uniqueName))}</span>`;
      return `<span class="chip">${esc(ev.type || 'Event')}</span>`;
    }).join('');
    return monthHead + `<div class="row"><span class="label">${esc(label)}</span><span class="value">${evs || '<span class="entry-sub">—</span>'}</span></div>`;
  }).join('');
  return head + days;
}

function rFaceoff(d) {
  const f = d.faceoffBonus;
  if (!f) return empty('No Faceoff bonus data in this feed snapshot.');
  const now = Date.now();
  if (Date.parse(f.activation) <= now && Date.parse(f.expiry) > now) {
    return row('Faceoff bonus', `Active · ${timer(f.expiry, 'ends in ')}`);
  }
  return row('Faceoff bonus', `Next window <span class="nowrap">${esc(fmtDate(f.next || f.activation))}</span>`);
}

function rClanWeekly(d) {
  const c = d.clanWeeklyInitiative;
  if (!c) return empty('No clan weekly data in this feed snapshot.');
  // The feed itself spells this key "rewwards" (three w's) — not a typo here.
  const rewards = (c.rewwards || []).map((r) => `<tr>
      <td class="num">${num(r.PointThreshold)}</td>
      <td>${esc(pathName(r.Reward))}</td>
      <td class="num">${num(r.ItemCount)}</td>
      <td>${r.RewardClaimed ? 'Claimed' : 'Unclaimed'}</td>
    </tr>`).join('');
  return `<div class="entry-head"><span class="entry-title">Week ${esc(c.week ?? '')} — bonus region: ${esc(c.bonusRegion || '')}</span>${timer(c.expiry, 'ends in ')}</div>
    <div class="table-wrap"><table><thead><tr><th class="num">Points</th><th>Reward</th><th class="num">Count</th><th>Status</th></tr></thead><tbody>${rewards}</tbody></table></div>`;
}

function rSyndicates(d) {
  const all = d.syndicateMissions || [];
  const withNodes = all.filter((s) => (s.nodes || []).length);
  const bare = all.filter((s) => !(s.nodes || []).length && !(s.jobs || []).length).length;
  if (!withNodes.length) return empty('No syndicate missions listed in this feed snapshot.')
    + (bare ? `<p class="note">${bare} other syndicate entries in the feed list no missions.</p>` : '');
  return withNodes.map((s) => `<div class="entry">
      <div class="entry-head"><span class="entry-title">${esc(s.syndicate)}</span>${timer(s.expiry, 'resets in ')}</div>
      ${chips(s.nodes)}
    </div>`).join('')
    + (bare ? `<p class="note">${bare} other syndicate entries in the feed list no missions or bounties.</p>` : '');
}

function rBounties(d) {
  const withJobs = (d.syndicateMissions || []).filter((s) => (s.jobs || []).length);
  if (!withJobs.length) return empty('No bounties listed in this feed snapshot.');
  // A syndicate can contribute two job sets (two rotations); group them and
  // label the sets instead of showing the same syndicate heading twice.
  const bySyn = new Map();
  withJobs.forEach((s) => {
    if (!bySyn.has(s.syndicate)) bySyn.set(s.syndicate, []);
    bySyn.get(s.syndicate).push(s);
  });
  let poolIdx = 0;
  const parts = [];
  for (const [syn, sets] of bySyn) {
    const sorted = [...sets].sort((a, b) => (Date.parse(a.expiry) || 0) - (Date.parse(b.expiry) || 0));
    sorted.forEach((s, si) => {
      const jobs = s.jobs.map((j) => {
        const drops = (j.rewardPoolDrops || []);
        // The feed flattens every stage's drops into one list with no stage
        // field, so stages cannot be regrouped; exact item+chance repeats
        // (the same drop offered by several stages) are shown once.
        const seenDrop = new Set();
        const dropChips = drops.filter((x) => {
          const k = `${x.item}|${x.chance}`;
          if (seenDrop.has(k)) return false;
          seenDrop.add(k);
          return true;
        }).map((x) => `${x.item}${x.chance != null ? ` (${x.chance}%)` : ''}`);
        const pool = drops.length
          ? chips(dropChips)
          : chips([...new Set(j.rewardPool || [])]);
        const standing = (j.standingStages || []).reduce((a, b) => a + b, 0);
        const stages = (j.standingStages || []).length;
        const idx = poolIdx++;
        return `<div class="entry">
        <div class="entry-head"><span class="entry-title">${esc(j.type || 'Bounty')}</span><span class="entry-tools"><span class="entry-sub">${timer(j.expiry, 'ends in ')}</span><button type="button" class="pool-toggle" data-pool="${idx}" aria-expanded="false">Reward pool</button></span></div>
        <div class="entry-sub">${(j.enemyLevels || []).length ? `Enemy ${lvlRange(j.enemyLevels[0], j.enemyLevels[j.enemyLevels.length - 1])} · ` : ''}${standing ? `${num(standing)} standing · ` : ''}${j.minMR ? `MR ${j.minMR}+ · ` : ''}${stages} stage${stages === 1 ? '' : 's'}</div>
        <div class="pool-body" data-pool-body="${idx}" hidden>${pool}</div>
      </div>`;
      }).join('');
      const label = sorted.length > 1 ? `${syn} — Rotation ${si + 1}` : syn;
      parts.push(`<h3>${esc(label)}</h3><div class="entries-2col">${jobs}</div>`);
    });
  }
  return parts.join('');
}

function mountBounties(el) {
  el.querySelectorAll('.pool-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const body = el.querySelector(`[data-pool-body="${btn.dataset.pool}"]`);
      if (!body) return;
      body.hidden = !body.hidden;
      btn.setAttribute('aria-expanded', String(!body.hidden));
    });
  });
}

function rConclave(d) {
  const list = d.conclaveChallenges || [];
  if (!list.length) return empty('No Conclave challenges in this feed snapshot.');
  const item = (c) => `<div class="entry">
      <div class="entry-head"><span class="entry-title">${esc(c.title || '')}</span><span class="entry-sub">${num(c.standing)} standing · ${timer(c.expiry, 'ends in ')}</span></div>
      <div class="entry-sub">${esc(c.description || '')} · ${esc(c.mode || '')}</div>
    </div>`;
  const daily = list.filter((c) => c.daily);
  const weekly = list.filter((c) => !c.daily);
  return `<h3>Daily</h3>${daily.length ? daily.map(item).join('') : empty('No daily challenges.')}`
    + `<h3>Weekly</h3>${weekly.length ? weekly.map(item).join('') : empty('No weekly challenges.')}`;
}

function traderWindow(t) {
  const now = Date.now();
  if (Date.parse(t.activation) > now) return `${timer(t.activation, 'arrives in ')}`;
  if (Date.parse(t.expiry) > now) return `${timer(t.expiry, 'leaves in ')}`;
  return 'Departed';
}

// A price column is rendered only when at least one row carries that price;
// a column that would be all placeholders is omitted entirely.
function inventoryTable(inv, priceLabel) {
  if (!(inv || []).length) return empty('No inventory published by the source for this visit.');
  const showPrice = inv.some((it) => it.ducats != null);
  const showCredits = inv.some((it) => it.credits != null);
  const rows = inv.map((it) => `<tr>
      <td><span class="item-cell">${itemIcon(it.thumbnail, it.uniqueName)}<span data-name-for="${esc(it.uniqueName || '')}">${esc(displayName(it.item, it.uniqueName))}</span></span></td>
      ${showPrice ? `<td class="num">${it.ducats != null ? num(it.ducats) : '—'}</td>` : ''}
      ${showCredits ? `<td class="num">${it.credits != null ? num(it.credits) : '—'}</td>` : ''}
    </tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr><th>Item</th>${showPrice ? `<th class="num">${esc(priceLabel)}</th>` : ''}${showCredits ? '<th class="num">Credits</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function rBaro(d) {
  const t = d.voidTrader;
  if (!t) return empty('No Void Trader data in this feed snapshot.');
  const others = (d.voidTraders || []).filter((x) => x.id !== t.id);
  const otherRows = others.map((x) => row(traderDisplayName(x.character), `${esc(x.location || '')} · ${traderWindow(x)}`));
  const present = Date.parse(t.activation) <= Date.now() && (t.inventory || []).length > 0;
  if (!present) {
    // Away (or inventory unpublished): the compact summary form, same shape
    // as the Overview highlight; the registry span drops to 1 to match.
    return [row(traderDisplayName(t.character), `${esc(t.location || '')} · ${traderWindow(t)}`),
      ...otherRows,
      `<p class="note">Inventory is published when the trader arrives.</p>`].join('');
  }
  return [`<div class="entry-head"><span class="entry-title">${esc(traderDisplayName(t.character))}</span><span>${traderWindow(t)}</span></div>
    <div class="entry-sub">${esc(t.location || '')}</div>`,
  inventoryTable(t.inventory, 'Ducats'), ...otherRows].join('');
}

function rVarzia(d) {
  const t = d.vaultTrader;
  if (!t) return empty('No Prime Resurgence data in this feed snapshot.');
  const out = [`<div class="entry-head"><span class="entry-title">${esc(t.character || 'Varzia')}</span>${timer(t.expiry, 'rotation ends in ')}</div>
    <div class="entry-sub">${esc(t.location || '')}</div>`,
  inventoryTable(t.inventory, 'Regal Aya')];
  const sched = (t.schedule || []).slice(0, 10);
  if (sched.length) {
    out.push(`<h3>Featured schedule (source-provided)</h3>` + sched.map((s) => row(displayName(s.item, s.uniqueName), esc(fmtDate(s.expiry)))).join(''));
  }
  return out.join('');
}

function rDarvo(d) {
  const list = d.dailyDeals || [];
  if (!list.length) return empty('No daily deal in this feed snapshot.');
  return list.map((deal) => `<div class="entry">
      <div class="entry-head"><span class="entry-title"><span class="item-cell">${itemIcon(deal.thumbnail, deal.uniqueName)}<span data-name-for="${esc(deal.uniqueName || '')}">${esc(displayName(deal.item, deal.uniqueName))}</span></span></span>${timer(deal.expiry, 'ends in ')}</div>
      <div class="entry-sub">${num(deal.salePrice)} plat${deal.originalPrice ? ` (was ${num(deal.originalPrice)})` : ''}${deal.discount ? ` · −${deal.discount}%` : ''} · ${num(deal.sold || 0)}/${num(deal.total || 0)} sold</div>
    </div>`).join('');
}

function rPrimeAccess(d) {
  const p = d.primeAccess;
  if (!p) return empty('Prime Access state is not present in this feed snapshot.');
  return row('Prime Access', esc(typeof p === 'string' ? p : (p.state || JSON.stringify(p))));
}

/* Flash sales carry their own search/filter/sort controls, like fissures.
   The collapse state (flashShowAll) persists across filter changes within
   the page session; the collapse always applies to the filtered list. */
const flashFilter = { q: '', discountOnly: false, sort: 'discount' };
let flashData = null;
let flashShowAll = false;
const FLASH_COLLAPSE = 25;
const NINETY_DAYS_MS = 90 * 24 * 3600 * 1000;

function flashList() {
  const list = (flashData || []).filter((f) => {
    if (flashFilter.discountOnly && !f.discount) return false;
    if (flashFilter.q && !displayName(f.item, f.uniqueName).toLowerCase().includes(flashFilter.q)) return false;
    return true;
  });
  const by = {
    discount: (a, b) => (b.discount || 0) - (a.discount || 0) || Date.parse(a.expiry) - Date.parse(b.expiry),
    ending: (a, b) => Date.parse(a.expiry) - Date.parse(b.expiry),
    name: (a, b) => displayName(a.item, a.uniqueName).localeCompare(displayName(b.item, b.uniqueName)),
  };
  return list.sort(by[flashFilter.sort] || by.discount);
}

function flashRows() {
  const list = flashList();
  if (!list.length) return empty('No flash sales match.');
  const shown = flashShowAll ? list : list.slice(0, FLASH_COLLAPSE);
  const rows = shown.map((f, i) => {
    const price = f.premiumOverride != null ? `${num(f.premiumOverride)} plat`
      : f.regularOverride != null ? `${num(f.regularOverride)} credits` : '—';
    // shortcut: icon lookups only for the first 24 rendered rows — one
    // items-API search per item would hammer the API across ~155 sales.
    const icon = i < 24 ? itemIcon('', f.uniqueName) : '';
    // Countdowns past ~90 days are meaningless ("1158d 17h"); show the date.
    const ends = Date.parse(f.expiry) - Date.now() > NINETY_DAYS_MS
      ? esc(fmtDateYear(f.expiry))
      : timer(f.expiry, '');
    return `<tr>
      <td><span class="item-cell">${icon}<span data-name-for="${esc(f.uniqueName || '')}">${esc(displayName(f.item, f.uniqueName))}</span></span></td>
      <td class="num">${price}</td>
      <td class="num">${f.discount ? `−${f.discount}%` : '—'}</td>
      <td class="num">${ends}</td>
    </tr>`;
  }).join('');
  const note = flashShowAll || list.length <= FLASH_COLLAPSE
    ? `${list.length} sale(s)`
    : `Showing ${FLASH_COLLAPSE} of ${list.length} sales`;
  const toggle = list.length > FLASH_COLLAPSE
    ? `<button type="button" class="flash-toggle" data-flash-toggle>${flashShowAll ? 'Show fewer' : `Show all ${list.length}`}</button>`
    : '';
  return `<p class="note">${note}</p>
    <div class="table-wrap"><table><thead><tr><th>Item</th><th class="num">Price</th><th class="num">Discount</th><th class="num">Ends</th></tr></thead><tbody>${rows}</tbody></table></div>${toggle}`;
}

function rFlashSales(d) {
  // The feed lists some sales twice verbatim; exact duplicates (same item,
  // same price fields, same expiry) collapse to one row.
  const seenSale = new Set();
  flashData = [...(d.flashSales || [])].filter((f) => {
    const k = `${f.item}|${f.premiumOverride}|${f.regularOverride}|${f.expiry}`;
    if (seenSale.has(k)) return false;
    seenSale.add(k);
    return true;
  });
  const sortOpts = [['discount', 'Discount'], ['ending', 'Ending soon'], ['name', 'Name A–Z']]
    .map(([v, label]) => `<option value="${v}"${flashFilter.sort === v ? ' selected' : ''}>${label}</option>`).join('');
  return `<div class="filters">
      <label>Search <input type="search" data-f="q" placeholder="Item name…" value="${esc(flashFilter.q)}"></label>
      <label>Sort <select data-f="sort">${sortOpts}</select></label>
      <label class="check"><input type="checkbox" data-f="discountOnly"${flashFilter.discountOnly ? ' checked' : ''}> Discounts only</label>
    </div>
    <div class="flash-list">${flashRows()}</div>`;
}

function mountFlashSales(el) {
  const q = el.querySelector('input[data-f="q"]');
  const cb = el.querySelector('input[data-f="discountOnly"]');
  const sortSel = el.querySelector('select[data-f="sort"]');
  const update = () => {
    flashFilter.q = (q.value || '').toLowerCase();
    flashFilter.discountOnly = cb.checked;
    if (sortSel) flashFilter.sort = sortSel.value;
    el.querySelector('.flash-list').innerHTML = flashRows();
    tickTimers();
    enrichIcons(el);
    wireToggle();
  };
  const wireToggle = () => {
    const btn = el.querySelector('[data-flash-toggle]');
    if (btn) btn.addEventListener('click', () => { flashShowAll = !flashShowAll; update(); });
  };
  q.addEventListener('input', update);
  cb.addEventListener('change', update);
  if (sortSel) sortSel.addEventListener('change', update);
  wireToggle();
}

function rAcolytes(d) {
  const list = d.persistentEnemies || [];
  if (!list.length) return empty('No Acolytes active.');
  return list.map((e) => `<div class="entry">
      <div class="entry-head"><span class="entry-title">${esc(e.name || displayName('', e.agentType) || 'Acolyte')}</span>
      <span class="entry-sub">${typeof e.healthPercent === 'number' ? `${(e.healthPercent * 100).toFixed(1)}% health` : ''}</span></div>
      <div class="entry-sub">${esc(e.lastNode || e.node || '')}</div>
    </div>`).join('');
}

function rSimaris(d) {
  const s = d.simaris;
  if (!s || !s.target) return empty('No Synthesis target in this feed snapshot.');
  return row('Current Synthesis target', esc(s.target))
    + row('Status', s.isTargetActive ? 'Active' : 'Not currently active');
}

function rGlobalUpgrades(d) {
  const list = d.globalUpgrades || [];
  if (!list.length) return empty('No global upgrades or boosters active.');
  return list.map((g) => `<div class="entry">
      <div class="entry-head"><span class="entry-title">${esc(g.upgradeType || g.description || 'Global upgrade')}</span>${timer(g.expiry, 'ends in ')}</div>
      <div class="entry-sub">${esc(g.operationType || '')}${g.value != null ? ` · ${esc(g.value)}` : ''}</div>
    </div>`).join('');
}

function rDarkSectors(d) {
  const list = d.darkSectors || [];
  if (!list.length) return empty('No dark sector conflicts in this feed snapshot.');
  return list.map((s) => `<div class="entry">
      <div class="entry-head"><span class="entry-title">${esc(s.name || s.node || 'Dark sector')}</span>${timer(s.expiry, 'ends in ')}</div>
      <div class="entry-sub">${esc(s.defenderName || '')}${s.resourceTaxRate != null ? ` · Resource tax ${s.resourceTaxRate}%` : ''}${s.creditTaxRate != null ? ` · Credit tax ${s.creditTaxRate}%` : ''}</div>
    </div>`).join('');
}

function rKinepage(d) {
  const k = d.kinepage;
  if (!k || !k.message) return empty('No radio message in this feed snapshot.');
  return `<p>${esc(k.message)}</p><p class="note">— Höllvania radio, ${esc(fmtDate(k.timestamp))}</p>`;
}

/* ============================== registries ============================== */

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'alerts', label: 'Alerts & Events' },
  { id: 'fissures', label: 'Fissures' },
  { id: 'invasions', label: 'Invasions' },
  { id: 'sortie', label: 'Sortie & Archon' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'bounties', label: 'Bounties' },
  { id: 'traders', label: 'Traders & Market' },
  { id: 'more', label: 'More' },
];

/* To move a section: change its `tab:` value. To reorder: move its entry.
   To add one: append an entry with a self-contained render function.
   `span: 2` gives a section two grid columns on wide screens; it travels
   with the entry, so a moved section keeps its width. */
const SECTIONS = [
  { id: 'cycles', tab: 'overview', title: 'World Cycles', render: rCycles },
  { id: 'construction', tab: 'overview', title: 'Enemy Construction', render: rConstruction },
  { id: 'overview-traders', tab: 'overview', title: 'Traders & Deals', render: rOverviewTraders },
  { id: 'overview-daily', tab: 'overview', title: 'Daily & Weekly Highlights', render: rOverviewDaily },

  { id: 'alerts', tab: 'alerts', title: 'Alerts', span: 2, render: rAlerts },
  { id: 'events', tab: 'alerts', title: 'Events', span: 2, render: rEvents },
  { id: 'news', tab: 'alerts', title: 'News', render: rNews },

  { id: 'fissures', tab: 'fissures', title: 'Void Fissures', span: 2, render: rFissures, mount: mountFissures },

  { id: 'invasions', tab: 'invasions', title: 'Invasions', span: 2, render: rInvasions },

  { id: 'sortie', tab: 'sortie', title: 'Sortie', span: 2, render: rSortie },
  { id: 'archon', tab: 'sortie', title: 'Archon Hunt', span: 2, render: rArchon },
  { id: 'arbitration', tab: 'sortie', title: 'Arbitration', render: rArbitration },

  { id: 'nightwave', tab: 'weekly', title: 'Nightwave', render: rNightwave },
  { id: 'circuit', tab: 'weekly', title: 'The Circuit (Duviri)', render: rCircuit },
  { id: 'steelpath', tab: 'weekly', title: 'Steel Path Honors', render: rSteelPath },
  { id: 'archimedea', tab: 'weekly', title: 'Archimedea', render: rArchimedea },
  { id: 'descendia', tab: 'weekly', title: 'Descendia', span: 2, render: rDescendia },
  { id: 'calendar', tab: 'weekly', title: '1999 Calendar', span: 2, render: rCalendar },
  { id: 'faceoff', tab: 'weekly', title: 'Faceoff Bonus', render: rFaceoff },
  { id: 'clanweekly', tab: 'weekly', title: 'Clan Weekly Initiative', render: rClanWeekly },

  { id: 'syndicates', tab: 'bounties', title: 'Syndicate Missions', span: 2, render: rSyndicates },
  { id: 'bounties', tab: 'bounties', title: 'Bounties', span: 2, render: rBounties, mount: mountBounties },
  { id: 'conclave', tab: 'bounties', title: 'Conclave Challenges', render: rConclave },

  { id: 'baro', tab: 'traders', title: "Void Trader — Baro Ki'Teer",
    // Span follows the data, resolved at render time: the full inventory
    // table takes 2 columns; the away summary is a compact 1-column section.
    span: (d) => (d.voidTrader && Date.parse(d.voidTrader.activation) <= Date.now()
      && (d.voidTrader.inventory || []).length ? 2 : 1),
    render: rBaro },
  { id: 'varzia', tab: 'traders', title: 'Prime Resurgence — Varzia', span: 2, render: rVarzia },
  { id: 'darvo', tab: 'traders', title: 'Darvo — Daily Deal', render: rDarvo },
  { id: 'primeaccess', tab: 'traders', title: 'Prime Access', render: rPrimeAccess },
  { id: 'flashsales', tab: 'traders', title: 'Flash Sales', span: 2, render: rFlashSales, mount: mountFlashSales },

  { id: 'acolytes', tab: 'more', title: 'Persistent Enemies (Acolytes)', render: rAcolytes },
  { id: 'simaris', tab: 'more', title: 'Synthesis (Simaris)', render: rSimaris },
  { id: 'globalupgrades', tab: 'more', title: 'Global Upgrades', render: rGlobalUpgrades },
  { id: 'darksectors', tab: 'more', title: 'Dark Sectors', render: rDarkSectors },
  { id: 'kinepage', tab: 'more', title: 'Kinepage', render: rKinepage },
];

/* ============================== engine ============================== */

const state = { data: null };
const iconCache = new Map();

function buildSkeleton() {
  const tabBar = document.getElementById('tab-bar');
  const panels = document.getElementById('panels');
  tabBar.innerHTML = TABS.map((t, i) => `<button type="button" class="tab${i === 0 ? ' active' : ''}" data-tab="${esc(t.id)}">${esc(t.label)}</button>`).join('')
    + '<button type="button" class="tab-refresh refresh-btn">Refresh</button>';
  panels.innerHTML = TABS.map((t, i) => `<section class="tab-panel" data-panel="${esc(t.id)}"${i === 0 ? '' : ' hidden'}><div class="grid" data-grid="${esc(t.id)}"></div></section>`).join('');
  for (const s of SECTIONS) {
    const grid = panels.querySelector(`[data-grid="${s.tab}"]`);
    if (!grid) continue;
    const card = document.createElement('article');
    card.className = 'card' + (s.span === 2 ? ' span-2' : '');
    card.id = `sec-${s.id}`;
    card.innerHTML = `<h2>${esc(s.title)}</h2><div class="section-body"></div>`;
    grid.appendChild(card);
  }
  // A tab with no sections still renders an explicit note, never a blank page.
  for (const t of TABS) {
    const grid = panels.querySelector(`[data-grid="${t.id}"]`);
    if (grid && !grid.children.length) grid.innerHTML = `<div class="card">${empty('Nothing here yet.')}</div>`;
  }
  tabBar.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });
}

function activateTab(id) {
  document.querySelectorAll('.tab-bar .tab').forEach((b) => {
    const on = b.dataset.tab === id;
    b.classList.toggle('active', on);
    if (on) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== id; });
  window.scrollTo(0, 0);
}

function renderAll() {
  for (const s of SECTIONS) {
    const card = document.getElementById(`sec-${s.id}`);
    if (!card) continue;
    const body = card.querySelector('.section-body');
    try {
      body.innerHTML = state.data ? s.render(state.data) : empty('Waiting for data…');
      // A section whose whole content is empty-state text gets the slim
      // is-empty card treatment automatically (see styles.css).
      const kids = [...body.children];
      card.classList.toggle('is-empty', kids.length > 0
        && kids.every((k) => k.classList.contains('empty') || k.classList.contains('note')));
      if (state.data) {
        const sp = typeof s.span === 'function' ? s.span(state.data) : s.span;
        card.classList.toggle('span-2', sp === 2);
        if (s.mount) s.mount(card, state.data);
      }
    } catch (err) {
      body.innerHTML = empty('This section failed to render.');
      console.error(`section ${s.id} failed`, err);
    }
  }
  tickTimers();
  enrichIcons(document);
}

function tickTimers() {
  const now = Date.now();
  document.querySelectorAll('[data-expiry]').forEach((el) => {
    const t = Date.parse(el.dataset.expiry);
    if (!Number.isFinite(t)) { el.textContent = ''; return; }
    const rem = t - now;
    if (rem <= 0) {
      el.textContent = 'Ended';
      el.classList.remove('t-urgent', 't-soon');
      return;
    }
    el.textContent = (el.dataset.prefix || '') + fmtDur(rem);
    el.classList.toggle('t-urgent', rem < 15 * 60 * 1000);
    el.classList.toggle('t-soon', rem >= 15 * 60 * 1000 && rem < 60 * 60 * 1000);
  });
}

/* Sparingly enrich trader/market icons the feed did not thumbnail: one
   items-API search per unique path, cached, failures degrade to no icon. */
async function enrichIcons(root) {
  const imgs = [...root.querySelectorAll('img[data-lookup]')].filter((i) => !i.dataset.done);
  const wanted = [...new Set(imgs.map((i) => i.dataset.lookup))].slice(0, 60);
  for (const uniqueName of wanted) {
    if (!uniqueName) continue;
    if (!iconCache.has(uniqueName)) {
      iconCache.set(uniqueName, (async () => {
        try {
          const q = encodeURIComponent(pathName(uniqueName));
          const res = await fetch(`https://api.warframestat.us/items/search/${q}`);
          if (!res.ok) return null;
          const results = await res.json();
          const hit = (results || []).find((r) => r.uniqueName === uniqueName);
          return hit ? { imageName: hit.imageName, name: hit.name } : null;
        } catch { return null; }
      })());
    }
    const hit = await iconCache.get(uniqueName);
    if (!hit) continue;
    root.querySelectorAll(`img[data-lookup="${CSS.escape(uniqueName)}"]`).forEach((img) => {
      img.dataset.done = '1';
      if (hit.imageName) { img.src = ICON_CDN + hit.imageName; img.hidden = false; }
    });
    if (hit.name) {
      root.querySelectorAll(`[data-name-for="${CSS.escape(uniqueName)}"]`).forEach((el) => {
        if (isMangled(el.textContent)) el.textContent = hit.name;
      });
    }
  }
}

// Reference tables (language dictionary, node regions, ...) load once;
// the promise is cached only while it succeeds, so a failed statics fetch
// degrades to humanized fallbacks for one refresh and retries next time.
let staticsPromise = null;
function loadStatics() {
  if (!staticsPromise) {
    staticsPromise = fetch(STATICS_URL)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .catch((err) => {
        staticsPromise = null;
        console.error('statics load failed; rendering with fallbacks this refresh', err);
        return {};
      });
  }
  return staticsPromise;
}

// Same load-once pattern for the WFCD reference tables (bounty pools,
// sortie data, Steel Path rotation, conclave challenges): without them
// the translator falls back to its table-less behaviour for one refresh.
let referencePromise = null;
function loadReference() {
  if (!referencePromise) {
    referencePromise = fetch(REFERENCE_URL)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .catch((err) => {
        referencePromise = null;
        console.error('reference load failed; rendering without tables this refresh', err);
        return {};
      });
  }
  return referencePromise;
}

async function load() {
  const banner = document.getElementById('error-banner');
  try {
    const res = await fetch(FEED_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const live = await res.json();
    const statics = await loadStatics();
    const ref = await loadReference();
    state.data = translateWorldState(live, statics, ref);
    banner.hidden = true;
    document.getElementById('build-label').textContent = state.data.buildLabel ? `Build ${state.data.buildLabel}` : '';
    // The stamp shows the DATA's own timestamp, not the fetch time, and
    // flags the data visibly once it is more than 10 minutes old.
    const updatedEl = document.getElementById('last-updated');
    const dataMs = Date.parse(state.data.timestamp);
    if (Number.isFinite(dataMs)) {
      const stale = Date.now() - dataMs > 10 * 60 * 1000;
      updatedEl.textContent = `Data as of ${new Date(dataMs).toLocaleTimeString('en-US')}${stale ? ' — STALE (over 10 min old)' : ''}`;
      updatedEl.classList.toggle('timer', stale);
      updatedEl.classList.toggle('t-urgent', stale);
    } else {
      updatedEl.textContent = '';
    }
    renderAll();
  } catch (err) {
    console.error('world state fetch failed', err);
    document.getElementById('error-text').textContent = state.data
      ? 'Refresh failed — showing the last good data.'
      : 'Could not load world state data. Check your connection and retry.';
    banner.hidden = false;
    if (!state.data) renderAll();
  }
}

function boot() {
  buildSkeleton();
  const hash = (location.hash || '').replace('#', '');
  if (TABS.some((t) => t.id === hash)) activateTab(hash);
  document.querySelectorAll('.refresh-btn').forEach((b) => b.addEventListener('click', load));
  document.getElementById('retry-btn').addEventListener('click', load);
  load();
  setInterval(load, REFRESH_MS);
  setInterval(tickTimers, 1000);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

/* Exported for the build-time render-check harness (no effect in browser). */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TABS, SECTIONS, fmtDur, pathName, cleanKey, displayName, isMangled, isArbStub, rewardHTML, num, lvlRange };
}
