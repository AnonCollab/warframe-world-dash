'use strict';
/*
 * WorldDash translator: raw world state feed -> the parsed dialect the
 * renderers in app.js consume.
 *
 * Input 1 (live): the relay payload { worldState, resolvedItems,
 *   bountyCycle, constructionProgress, staticData, lastUpdated,
 *   nextRefresh }, where worldState is Digital Extremes' raw feed
 *   (SolNode codes, /Lotus paths, Mongo $date/$oid wrappers).
 * Input 2 (statics): static-data.json — the reference tables (language
 *   dictionary, node regions, challenge definitions, mission types,
 *   factions, arbitration tiers) snapshotted from the same source the
 *   relay mirrors.
 * Input 3 (ref): reference-data.json — open-data tables snapshotted by
 *   the same weekly job: reward decks from browse.wf's
 *   warframe-public-export-plus with item names from WFCD
 *   warframe-items, plus WFCD warframe-worldstate-data tables (sortie
 *   bosses/modifiers, the Steel Path rotation, conclave challenges,
 *   synthesis targets, acolyte regions, global upgrade names).
 *   Optional: every join below falls back to the pre-reference
 *   behaviour without it.
 *
 * Field semantics and cycle mathematics are ported from the WFCD
 * warframe-worldstate-parser (MIT), the parser that produced the old
 * dialect; translations resolve only from the two inputs above.
 *
 * Fail-soft throughout: a missing dictionary entry resolves to a
 * readable humanization of the raw key, a missing raw section becomes
 * the dialect's empty form, and nothing here throws on bad input.
 */

(function (global) {
  /* ============================ primitives ============================ */

  // Raw feed dates arrive as { $date: { $numberLong: "<ms>" } } (or a
  // plain ISO string / epoch in a few fields). -> epoch ms or NaN.
  function rawMs(v) {
    if (v == null) return NaN;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return Date.parse(v);
    if (typeof v === 'object') {
      if (v.$date != null) return rawMs(v.$date);
      if (v.$numberLong != null) return Number(v.$numberLong);
    }
    return NaN;
  }

  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);
  const oid = (o) => (o && o.$oid) || '';
  const arr = (v) => (Array.isArray(v) ? v : []);
  const obj = (v) => (v && typeof v === 'object' ? v : {});

  // "MPVNidusPrimeSinglePack" / "/Lotus/.../BioComponent" ->
  // "Nidus Prime Single Pack" / "Bio Component". Same transform app.js
  // applies to feed names, duplicated because this file must stand alone.
  function humanize(p) {
    if (!p) return '';
    let tail = String(p).split('/').filter(Boolean).pop() || String(p);
    tail = tail.replace(/\.(level|json)$/i, '').replace(/^MPV/, '');
    return tail
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

  // Feed enum ("MT_DEFENSE", "FC_GRINEER") -> display ("Defense", "Grineer").
  function cleanEnum(key, prefixes) {
    if (!key) return '';
    let s = String(key);
    for (const p of prefixes) if (s.startsWith(p + '_')) { s = s.slice(p.length + 1); break; }
    return humanize(s.replace(/_/g, ' '));
  }

  // "2h 20m 0s" style, matching the old dialect's timeLeft strings.
  function timeLeftStr(ms) {
    let s = Math.max(0, Math.floor(ms / 1000));
    const pieces = [];
    if (s > 3600) { pieces.push(`${Math.floor(s / 3600)}h`); s %= 3600; }
    if (s > 60) { pieces.push(`${Math.floor(s / 60)}m`); s %= 60; }
    pieces.push(`${s}s`);
    return pieces.join(' ');
  }

  // Monday 00:00 UTC week boundaries around `now` (parser's weeklyReset).
  function weeklyReset(now) {
    const d = new Date(now);
    const untilMon = d.getUTCDay() === 0 ? 1 : 8 - d.getUTCDay();
    const expiry = new Date(d.getTime());
    expiry.setUTCDate(d.getUTCDate() + untilMon);
    expiry.setUTCHours(0, 0, 0, 0);
    const activation = new Date(expiry.getTime());
    activation.setUTCDate(expiry.getUTCDate() - 7);
    return { activation, expiry };
  }

  /* ============================ translator ============================ */

  const syndicateIndexCache = new WeakMap();

  function translateWorldState(live, statics, ref) {
    live = obj(live);
    statics = obj(statics);
    ref = obj(ref);
    const ws = obj(live.worldState);
    const dict = obj(statics.dict);
    const osdict = obj(statics.osdict);
    const regions = obj(statics.regions);
    const challenges = obj(statics.challenges);
    const missionTypes = obj(statics.missionTypes);
    const factions = obj(statics.factions);
    const bountyRewards = obj(ref.bountyRewards);
    const sortieData = obj(ref.sortieData);
    const steelPathData = obj(ref.steelPath);
    const conclaveData = obj(ref.conclaveData);
    const persistentEnemyData = obj(ref.persistentEnemyData);
    const upgradeTypes = obj(ref.upgradeTypes);
    const simarisTargets = obj(ref.simarisTargets);
    const resolved = obj(live.resolvedItems);
    const dataSec = Number.isFinite(ws.Time) ? ws.Time : Math.floor(Date.now() / 1000);

    /* ---------- resolution helpers (fail-soft) ---------- */

    // Language-table lookup; osdict entries override the base dictionary.
    const lang = (key) => {
      if (!key || typeof key !== 'string') return undefined;
      if (Object.prototype.hasOwnProperty.call(osdict, key)) return osdict[key];
      if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
      return undefined;
    };
    // Game strings carry substitution tokens the client fills in:
    // |COUNT| is the challenge's required count, <DT_*> tags mark
    // damage-type icons, and |OPEN_COLOR|/|CLOSE_COLOR| wrap colored
    // spans. Fill what we can and convert the rest to private markers
    // (\u0001 icon-path \u0002, \u0003/\u0004 highlight span) that the
    // renderers' richText() turns into the game's own icons and a
    // highlighted span after HTML-escaping — raw tokens never reach
    // the page, and no string-table HTML is ever injected.
    const textIcons = obj(ref && ref.textIcons);
    // Icon resolution via the Public Export image manifest snapshot:
    // feed Icon fields and challenge-definition icons are bare texture
    // paths; deck items resolve by uniqueName. Both maps carry the
    // hashed textureLocation, served from DE's content CDN. The
    // manifest snapshot covers only part of the bare paths (152 of 267
    // challenge icons), so iconUrl falls back to browse.wf, which
    // serves game textures by bare path; a path neither source has
    // still 404s there and the renderers' self-removing img hides it.
    const iconTextures = obj(ref && ref.iconTextures);
    const itemIcons = obj(ref && ref.itemIcons);
    const ICON_CDN = 'https://content.warframe.com/PublicExport';
    const iconUrl = (path) => {
      if (!path) return '';
      if (iconTextures[path]) return `${ICON_CDN}${iconTextures[path]}`;
      return path.startsWith('/') ? `https://browse.wf${path}` : '';
    };
    const itemIconUrl = (uniqueName) => (uniqueName && itemIcons[uniqueName] ? `${ICON_CDN}${itemIcons[uniqueName]}` : '');
    const cleanText = (s, count) => String(s ?? '')
      .replace(/\|COUNT\|/g, count != null ? String(count) : '')
      .replace(/<DT_([A-Z_]+)>/g, (m, code) => {
        const p = textIcons[`DT_${code}`];
        return p ? `\u0001${p}\u0002` : '';
      })
      .replace(/\|OPEN_COLOR\|/g, '\u0003')
      .replace(/\|CLOSE_COLOR\|/g, '\u0004')
      .replace(/\s{2,}/g, ' ');
    // A language key (or any path) -> its string, else a humanized tail.
    const langStr = (key) => {
      if (!key) return '';
      const hit = lang(key);
      if (hit != null) return hit;
      return /\/Lotus\/Language\//i.test(key) || key.startsWith('/') ? humanize(key) : key;
    };
    // An item path -> display name. Order: fusion bundles (Endo
    // containers — DE's export names them "Endo" and carries the
    // amount, so a bundle reward reads as what it grants); the 1999
    // calendar items, whose names live only in /Lotus/Language/1999/
    // keys mirroring the item's file name; the payload's own resolved
    // items; the WFCD item-name map (keyed without the "/StoreItems"
    // segment, so both forms are tried); the language table; a
    // humanized tail.
    const fusionBundles = obj(ref && ref.fusionBundles);
    const itemNames = obj(ref && ref.itemNames);
    const cal99 = (path) => {
      const base = String(path).split('/').pop();
      const name = lang(`/Lotus/Language/1999/${base}Name`);
      if (!name) return null;
      return { name: cleanText(name), description: cleanText(lang(`/Lotus/Language/1999/${base}Desc`) ?? '') };
    };
    const itemName = (path) => {
      if (!path) return '';
      const fb = fusionBundles[path] || fusionBundles[path.replace('/StoreItems/', '/')];
      if (fb && fb.points) return `${Number(fb.points).toLocaleString('en-US')} ${fb.name || 'Endo'}`;
      const c99 = cal99(path);
      if (c99) return c99.name;
      const r = resolved[path];
      if (r && r.name) return r.name;
      const inm = itemNames[path] || itemNames[path.replace('/StoreItems/', '/')];
      // WFCD names recipe stubs just "Blueprint", which says less
      // than the humanized tail ("Weapon Utility Unlocker Blueprint").
      if (inm && inm !== 'Blueprint') return cleanText(inm).replace(/<[^>]+>/g, '').replace(/\s{2,}/g, ' ').trim();
      return langStr(path);
    };
    const nodeName = (id) => {
      if (!id) return '';
      const r = regions[id];
      if (!r) return humanize(id);
      const name = lang(r.name) ?? humanize(r.name || id);
      const sys = r.systemName ? (lang(r.systemName) ?? humanize(r.systemName)) : '';
      return sys ? `${name} (${sys})` : name;
    };
    const factionName = (fc) => {
      if (!fc) return '';
      const e = factions[fc];
      const n = e && lang(e.name);
      return n != null ? n : cleanEnum(fc, ['FC']);
    };
    const missionTypeName = (mt) => {
      if (!mt) return '';
      const e = missionTypes[mt];
      const n = e && lang(e.name);
      return n != null ? n : cleanEnum(mt, ['MT']);
    };

    // Syndicate display names live in the dictionary under
    // .../Syndicates/<Stem>Name-style keys, but the raw Tag does not map
    // to the stem mechanically (CetusSyndicate -> .../CetusName ->
    // "Ostron"). The index below is derived from the dictionary itself
    // at first use; tags with no key fall back to a humanized tag.
    const syndicateName = (tag) => {
      if (!tag) return '';
      let index = syndicateIndexCache.get(statics);
      if (!index) {
        index = new Map();
        for (const key of Object.keys(dict)) {
          const base = key.split('/').pop() || '';
          if (!base.endsWith('Name')) continue;
          const stem = base.slice(0, -4);
          if (!index.has(stem)) index.set(stem, key);
          const bare = stem.replace(/Syndicate$/, '');
          if (!index.has(bare)) index.set(bare, key);
        }
        syndicateIndexCache.set(statics, index);
      }
      const base = String(tag).replace(/Syndicate$/, '');
      const direct = lang(`/Lotus/Language/Syndicates/${base}Name`);
      if (direct != null) return direct;
      const hit = lang(index.get(base)) ?? lang(index.get(`${base}Syndicate`))
        ?? lang(index.get(`${base}Secret`));
      if (hit != null) return hit;
      // Prefix stems (Solaris -> SolarisSecretName) and prefixed stems
      // (Hex -> MessengerHexName): shortest matching index stem wins.
      let best = null;
      for (const [stem, key] of index) {
        const s = stem.toLowerCase(), b = base.toLowerCase();
        if (s.startsWith(b) || s.endsWith(b)) {
          if (!best || stem.length < best[0].length) best = [stem, key];
        }
      }
      return best ? (lang(best[1]) ?? humanize(base)) : humanize(base);
    };

    // Fissure tier from the raw VoidTn modifier; the display names are
    // the relic era strings in the language table.
    const tierFor = (modifier) => {
      const m = /^VoidT(\d)$/.exec(String(modifier || ''));
      if (!m) return { tier: humanize(modifier), tierNum: 0 };
      const n = Number(m[1]);
      const eras = ['LITH', 'MESO', 'NEO', 'AXI', 'REQUIEM', 'OMNI'];
      const names = ['Lith', 'Meso', 'Neo', 'Axi', 'Requiem', 'Omnia'];
      return { tier: lang(`/Lotus/Language/Relics/Era_${eras[n - 1]}`) ?? names[n - 1] ?? humanize(modifier), tierNum: n };
    };

    // Bounty reward pools: a job's rewards path is the exact key of
    // its reward deck in the reference tables (browse.wf's
    // warframe-public-export-plus ExportRewards). A deck is a list of
    // stage tables; the dialect flattens them into one pool, in order
    // (the old drop tables flattened the same way, stage duplicates
    // included — the renderer dedupes exact repeats). Item names come
    // from the reference item-name map (WFCD warframe-items), falling
    // back to the payload/dictionary/humanize chain. Chances are the
    // deck probabilities as percents; rarity follows the bands the old
    // drop tables used (verified against the previous dialect's pools:
    // <1% Legendary, <10% Rare, <32% Uncommon, otherwise Common).
    // Rarity-tiered deck entries (no probability) keep their tier and
    // a null chance. Jobs whose deck the tables don't carry keep
    // empty pools.
    const dropName = (p) => itemNames[p] ?? itemName(p);
    const rarityFor = (chance) => (chance < 1 ? 'Legendary' : chance < 10 ? 'Rare' : chance < 32 ? 'Uncommon' : 'Common');
    const bountyPool = (j) => {
      const deck = arr(bountyRewards[j && j.rewards]);
      if (!deck.length) return null;
      const drops = [];
      for (const table of deck) {
        for (const e of arr(table)) {
          if (!e || !e.type) continue;
          const name = dropName(e.type);
          if (typeof e.probability === 'number') {
            const chance = Math.round(e.probability * 10000) / 100;
            drops.push({ item: name, rarity: rarityFor(chance), chance, count: e.itemCount ?? 1, icon: itemIconUrl(e.type) });
          } else {
            drops.push({ item: name, rarity: e.rarity ? humanize(e.rarity) : '', chance: null, count: e.itemCount ?? 1, icon: itemIconUrl(e.type) });
          }
        }
      }
      if (!drops.length) return null;
      return { rewardPool: drops.map((x) => x.item), rewardPoolDrops: drops };
    };

    /* ---------- shared object builders ---------- */

    // Raw reward { credits, items[], countedItems[] } -> dialect reward.
    // Item icons come from the payload's resolvedItems when present.
    function mkReward(raw) {
      raw = obj(raw);
      const items = arr(raw.items).map(itemName);
      const counted = [
        ...arr(raw.items).map((p) => ({ uniqueName: p, type: itemName(p), key: itemName(p), count: 1 })),
        ...arr(raw.countedItems).map((ci) => ({
          uniqueName: ci.ItemType, type: itemName(ci.ItemType), key: itemName(ci.ItemType), count: ci.ItemCount,
        })),
      ];
      const first = counted.find((c) => resolved[c.uniqueName] && resolved[c.uniqueName].icon);
      return {
        items,
        countedItems: counted,
        credits: raw.credits || 0,
        thumbnail: first ? resolved[first.uniqueName].icon : '',
        color: 0,
      };
    }

    function mkMission(mi) {
      mi = obj(mi);
      const node = nodeName(mi.location || mi.node);
      const type = missionTypeName(mi.missionType);
      const faction = factionName(mi.faction);
      return {
        description: langStr(mi.descText),
        node,
        nodeKey: node,
        type,
        typeKey: type,
        faction,
        factionKey: faction,
        reward: mi.missionReward ? mkReward(mi.missionReward) : undefined,
        minEnemyLevel: mi.minEnemyLevel,
        maxEnemyLevel: mi.maxEnemyLevel,
        maxWaveNum: mi.maxWaveNum,
        nightmare: !!mi.nightmare,
        archwingRequired: !!mi.archwingRequired,
        isSharkwing: !!mi.isSharkwingMission,
        levelOverride: langStr(mi.levelOverride),
        enemySpec: langStr(mi.enemySpec),
        advancedSpawners: arr(mi.advancedSpawners).map(langStr),
        requiredItems: arr(mi.requiredItems).map(itemName),
        requiredItemUniqueNames: arr(mi.requiredItems),
        leadersAlwaysAllowed: mi.leadersAlwaysAllowed,
      };
    }

    const traderItem = (it) => ({
      uniqueName: it.ItemType,
      thumbnail: itemIconUrl(it.ItemType),
      item: itemName(it.ItemType),
      ducats: Number.parseInt(String(it.PrimePrice), 10),
      credits: it.RegularPrice != null ? Number.parseInt(String(it.RegularPrice), 10) : null,
    });

    function mkTrader(raw, characterOverride) {
      const inventory = arr(raw.Manifest).map(traderItem);
      return {
        id: oid(raw._id),
        activation: iso(rawMs(raw.Activation)),
        expiry: iso(rawMs(raw.Expiry)),
        character: raw.Character ? raw.Character.replace("Baro'Ki Teel", "Baro Ki'Teer") : (characterOverride || ''),
        location: nodeName(raw.Node),
        inventory,
        psId: `${oid(raw._id)}${inventory.length}`,
        initialStart: iso(rawMs(raw.InitialStartDate)) || '1970-01-01T00:00:00.000Z',
        schedule: arr(raw.ScheduleInfo).map((s) => ({
          expiry: iso(rawMs(s.Expiry)),
          item: itemName(s.FeaturedItem),
          uniqueName: s.FeaturedItem,
        })),
      };
    }

    /* ---------- sections ---------- */

    const out = {};

    out.timestamp = iso(dataSec * 1000);
    out.buildLabel = ws.BuildLabel;

    out.news = arr(ws.Events)
      .filter((e) => arr(e.Messages).some((m) => m.LanguageCode === 'en'))
      .map((e) => {
        const en = arr(e.Messages).find((m) => m.LanguageCode === 'en') || {};
        const link = e.Prop || (arr(e.Links).find((l) => l.LanguageCode === 'en') || {}).Link || '';
        const translations = {};
        for (const m of arr(e.Messages)) translations[m.LanguageCode] = langStr(m.Message);
        return {
          id: oid(e._id),
          message: langStr(en.Message),
          link,
          imageLink: e.ImageUrl || '',
          priority: !!e.Priority,
          date: iso(rawMs(e.Date)) || '1970-01-01T00:00:00.000Z',
          translations,
          update: /(update|hotfix|patch-notes)/i.test(link),
          primeAccess: /(access)/i.test(link),
          stream: /(devstream|prime-time|warframeinternational|stream)/i.test(link),
          mobileOnly: !!e.MobileOnly,
        };
      });

    out.events = arr(ws.Goals).map((g) => {
      const ev = {
        id: oid(g._id),
        activation: iso(rawMs(g.Activation)),
        expiry: iso(rawMs(g.Expiry)),
        description: langStr(g.Desc),
        tooltip: g.ToolTip ? langStr(g.ToolTip) : undefined,
        tag: g.Tag,
        node: g.Node ? nodeName(g.Node) : undefined,
        concurrentNodes: arr(g.ConcurrentNodes).map(nodeName),
        faction: g.Faction ? factionName(g.Faction) : undefined,
        maximumScore: Number.parseInt(String(g.Goal), 10),
        currentScore: Number.parseInt(String(g.Count), 10),
        smallInterval: g.GoalInterim != null ? Number.parseInt(String(g.GoalInterim), 10) : null,
        largeInterval: g.GoalInterim2 != null ? Number.parseInt(String(g.GoalInterim2), 10) : null,
        scoreLocTag: g.ScoreLocTag ? langStr(g.ScoreLocTag) : undefined,
        rewards: g.Reward ? [mkReward(g.Reward)].filter((r) => r.countedItems.length > 0) : [],
        jobs: [],
        previousJobs: [],
        interimSteps: arr(g.InterimRewards).map((reward, i) => ({
          goal: Number.parseInt(String(arr(g.InterimGoals)[i]), 10),
          reward: reward ? mkReward(reward) : undefined,
        })),
        isPersonal: !!g.Personal,
        isCommunity: !!g.Community,
        icon: iconUrl(g.Icon),
      };
      if (g.HealthPct != null) ev.health = Number.parseFloat((g.HealthPct * 100).toFixed(2));
      return ev;
    });

    out.alerts = arr(ws.Alerts).map((a) => ({
      id: oid(a._id),
      activation: iso(rawMs(a.Activation)),
      expiry: iso(rawMs(a.Expiry)),
      mission: mkMission(a.MissionInfo),
      tag: a.Tag || undefined,
      icon: iconUrl(a.Icon),
    }));

    const mkSortie = (raw, isArchon) => {
      if (!raw) return undefined;
      const modifierTypes = obj(sortieData.modifierTypes);
      const modifierDescriptions = obj(sortieData.modifierDescriptions);
      const variants = arr(raw.Variants).map((v) => {
        const node = nodeName(v.node);
        const type = missionTypeName(v.missionType);
        return {
          missionType: type,
          missionTypeKey: type,
          modifier: modifierTypes[v.modifierType] ?? cleanEnum(v.modifierType, ['SORTIE_MODIFIER']),
          modifierDescription: modifierDescriptions[v.modifierType] ?? '',
          node,
          nodeKey: node,
        };
      });
      const missions = arr(raw.Missions).map((m) => {
        const node = nodeName(m.node);
        const type = missionTypeName(m.missionType);
        return {
          node, nodeKey: node, type, typeKey: type,
          nightmare: !!m.nightmare, archwingRequired: !!m.archwingRequired, isSharkwing: !!m.isSharkwingMission,
        };
      });
      // Boss name and faction come from the reference sortie table
      // (archon entries there already carry the "Archon" prefix and the
      // Narmer faction). Without the table, fall back: when every
      // variant sits on nodes of one faction, that faction is the
      // sortie's; archon hunts then leave it blank (their nodes are not
      // Narmer-controlled in the region table).
      let faction = '';
      if (!isArchon) {
        const fs = [...new Set(arr(raw.Variants).map((v) => (regions[v.node] || {}).faction).filter(Boolean))];
        if (fs.length === 1) faction = factionName(fs[0]);
      }
      const bossName = cleanEnum(raw.Boss, ['SORTIE_BOSS']);
      const bossInfo = obj(obj(sortieData.bosses)[raw.Boss]);
      return {
        id: oid(raw._id),
        activation: iso(rawMs(raw.Activation)),
        expiry: iso(rawMs(raw.Expiry)),
        rewardPool: langStr(raw.Reward),
        variants,
        missions,
        boss: bossInfo.name ?? (isArchon ? `Archon ${bossName}` : bossName),
        faction: bossInfo.faction ?? faction,
        factionKey: bossInfo.faction ?? faction,
      };
    };
    out.sortie = mkSortie(arr(ws.Sorties)[0], false);
    out.archonHunt = mkSortie(arr(ws.LiteSorties)[0], true);

    out.syndicateMissions = arr(ws.SyndicateMissions).map((sm) => {
      const expiryMs = rawMs(sm.Expiry);
      const name = syndicateName(sm.Tag);
      return {
        id: `${expiryMs}${sm.Tag}`,
        activation: iso(rawMs(sm.Activation)),
        expiry: iso(expiryMs),
        syndicate: name,
        syndicateKey: name,
        nodes: arr(sm.Nodes).map(nodeName),
        jobs: arr(sm.Jobs).map((j) => {
          const pool = bountyPool(j);
          const job = {
            id: `${(String(j.jobType || '').split('/').pop() || 'Vault')}${expiryMs}`,
            expiry: iso(expiryMs),
            uniqueName: j.rewards,
            rewardPool: pool ? pool.rewardPool : [],
            rewardPoolDrops: pool ? pool.rewardPoolDrops : [],
            type: j.isVault
              ? `Isolation Vault ${humanize(j.locationTag)}`.trim()
              : (j.jobType ? langStr(j.jobType) : undefined),
            enemyLevels: [j.minEnemyLevel, j.maxEnemyLevel],
            standingStages: arr(j.xpAmounts),
            minMR: j.masteryReq || 0,
            isVault: !!j.isVault,
            locationTag: j.locationTag,
          };
          // Narmer bounties bind to the day/night cycle (parser semantics):
          // Eidolon ones end with the night, 50 minutes before the set.
          const jt = String(j.jobType || '').toLowerCase();
          if (jt.includes('narmer')) {
            if (jt.includes('eidolon')) {
              job.timeBound = 'day';
              job.expiry = iso(expiryMs - 50 * 60 * 1000);
            } else job.timeBound = 'night';
          }
          return job;
        }),
      };
    });

    const mkFissure = (f, isStorm) => {
      const t = tierFor(f.Modifier || f.ActiveMissionTier);
      const node = nodeName(f.Node);
      return {
        id: oid(f._id),
        activation: iso(rawMs(f.Activation)),
        expiry: iso(rawMs(f.Expiry)),
        node,
        nodeKey: node,
        missionType: missionTypeName(f.MissionType || (regions[f.Node] || {}).missionType),
        missionTypeKey: missionTypeName(f.MissionType || (regions[f.Node] || {}).missionType),
        enemy: factionName((regions[f.Node] || {}).faction),
        enemyKey: factionName((regions[f.Node] || {}).faction),
        tier: t.tier,
        tierNum: t.tierNum,
        isStorm,
        isHard: !!f.Hard,
      };
    };
    out.fissures = [
      ...arr(ws.ActiveMissions).map((f) => mkFissure(f, false)),
      ...arr(ws.VoidStorms).map((f) => mkFissure(f, true)),
    ];

    out.globalUpgrades = arr(ws.GlobalUpgrades).map((g) => ({
      // Display name from the reference upgrade table (the raw keys are
      // internal booster types — GAMEPLAY_KILL_XP_AMOUNT is the affinity
      // booster, GAMEPLAY_MONEY_PICKUP_AMOUNT credits, GAMEPLAY_PICKUP_AMOUNT
      // resources, per the wiki's world state documentation).
      upgradeType: obj(upgradeTypes[g.UpgradeType]).value ?? cleanEnum(g.UpgradeType, []),
      operationType: g.OperationType,
      value: g.Value,
      activation: iso(rawMs(g.ActivationDate ?? g.Activation)),
      expiry: iso(rawMs(g.ExpiryDate ?? g.Expiry)),
    }));

    out.flashSales = arr(ws.FlashSales).map((f) => {
      const expiryMs = rawMs(f.EndDate);
      return {
        id: `${String(f.TypeName || '').split('/').pop()}${expiryMs}`,
        activation: iso(rawMs(f.StartDate)),
        expiry: iso(expiryMs),
        item: itemName(f.TypeName),
        uniqueName: f.TypeName,
        discount: f.Discount,
        regularOverride: f.RegularOverride,
        premiumOverride: f.PremiumOverride,
      };
    });

    out.invasions = arr(ws.Invasions).map((inv) => {
      const node = nodeName(inv.Node);
      const vsInfestation = /infest/i.test(String((inv.DefenderMissionInfo || {}).faction || ''));
      const atkReward = obj(inv.AttackerReward);
      const defReward = obj(inv.DefenderReward);
      return {
        id: oid(inv._id),
        activation: iso(rawMs(inv.Activation)),
        node,
        nodeKey: node,
        desc: langStr(inv.LocTag),
        attacker: {
          reward: Object.keys(atkReward).length ? mkReward(atkReward) : undefined,
          faction: factionName((inv.DefenderMissionInfo || {}).faction),
          factionKey: factionName((inv.DefenderMissionInfo || {}).faction),
        },
        defender: {
          reward: Object.keys(defReward).length ? mkReward(defReward) : undefined,
          faction: factionName((inv.AttackerMissionInfo || {}).faction),
          factionKey: factionName((inv.AttackerMissionInfo || {}).faction),
        },
        vsInfestation,
        count: inv.Count,
        requiredRuns: inv.Goal,
        completion: inv.Goal ? (1 + inv.Count / inv.Goal) * (vsInfestation ? 100 : 50) : 0,
        completed: !!inv.Completed,
      };
    });

    out.darkSectors = []; // the raw feed no longer carries BadlandNodes

    out.voidTraders = arr(ws.VoidTraders).map((t) => mkTrader(t))
      .sort((a, b) => Date.parse(a.activation) - Date.parse(b.activation));
    out.voidTrader = out.voidTraders[0];
    out.vaultTrader = arr(ws.PrimeVaultTraders).map((t) => mkTrader(t, 'Varzia'))[0];

    out.dailyDeals = arr(ws.DailyDeals).map((dd) => {
      const expiryMs = rawMs(dd.Expiry);
      return {
        id: `${String(dd.StoreItem || '').split('/').pop()}${expiryMs}`,
        activation: iso(rawMs(dd.Activation)),
        expiry: iso(expiryMs),
        item: itemName(dd.StoreItem),
        thumbnail: itemIconUrl(dd.StoreItem),
        uniqueName: dd.StoreItem,
        originalPrice: dd.OriginalPrice,
        salePrice: dd.SalePrice,
        total: dd.AmountTotal,
        sold: dd.AmountSold,
        discount: dd.Discount,
      };
    });

    const lib = obj(ws.LibraryInfo);
    // The feed names the synthesis target by number only
    // (…/Targets/Research7Target); the number -> name table is part of
    // the reference data (extracted from the WFCD language table —
    // synthTargets' "[Research]" entries are the same targets in
    // alphabetical order, so they cannot supply the numbering).
    const researchNo = /Research(\d+)Target/i.exec(String(lib.LastCompletedTargetType || ''));
    out.simaris = {
      target: lib.LastCompletedTargetType
        ? (researchNo && simarisTargets[researchNo[1]]) || langStr(lib.LastCompletedTargetType)
        : 'N/A',
      isTargetActive: !lib.LastCompletedTargetType,
    };

    out.conclaveChallenges = arr(ws.PVPChallengeInstances).map((c) => {
      // Title/description/standing, mode and category all resolve from
      // the reference conclave table (keyed by the bare challenge id;
      // the feed carries it as a /Lotus/PVPChallengeTypes/ path). The
      // regex/humanize paths remain as fallbacks when the table lacks
      // the entry.
      const info = obj(obj(conclaveData.challenges)[String(c.challengeTypeRefID || '').split('/').pop()]);
      const cat = String(c.Category || '');
      const categoryKey = obj(obj(conclaveData.categories)[c.Category]).value
        ?? (/DAILY/i.test(cat) ? 'day' : (/ROOT/i.test(cat) ? 'week_root' : 'week'));
      return {
        id: oid(c._id),
        activation: iso(rawMs(c.startDate)),
        expiry: iso(rawMs(c.endDate)),
        amount: arr(c.params)[0] ? arr(c.params)[0].v : undefined,
        mode: obj(obj(conclaveData.modes)[c.PVPMode]).value
          ?? (c.PVPMode === 'PVPMODE_ALL' ? 'Any Mode' : cleanEnum(c.PVPMode, ['PVPMODE'])),
        category: categoryKey,
        categoryKey,
        description: info.description ?? '',
        title: info.title ?? humanize(c.challengeTypeRefID),
        standing: info.standing ?? 0,
        daily: categoryKey.startsWith('day'),
        rootChallenge: categoryKey.includes('root'),
      };
    });

    out.persistentEnemies = arr(ws.PersistentEnemies).map((e) => {
      // The raw Region is an index into the reference region table
      // (parser semantics); the name resolves through the language
      // dictionary via the entry's LocTag, as before.
      const regionNames = arr(persistentEnemyData.regions);
      return {
        name: langStr(e.LocTag) || humanize(e.AgentType),
        agentType: e.AgentType,
        healthPercent: e.HealthPercent,
        fleeDamage: e.FleeDamage,
        rank: e.Rank,
        region: regionNames[e.Region] != null ? String(regionNames[e.Region]) : '',
        lastNode: e.LastDiscoveredLocation ? nodeName(e.LastDiscoveredLocation) : '',
        lastDiscoveredTime: iso(rawMs(e.LastDiscoveredTime)),
        isDiscovered: !!e.Discovered,
      };
    });

    /* ---------- cycles (computed; ported parser mathematics) ---------- */
    const now = Date.now();
    const cetusMission = arr(ws.SyndicateMissions).find((s) => s.Tag === 'CetusSyndicate');
    const cetusEndMs = cetusMission ? rawMs(cetusMission.Expiry) : NaN;

    {
      const cycleSeconds = Math.floor(now / 1000) % 28800;
      const isDay = cycleSeconds < 14400;
      const secondsLeft = 14400 - (cycleSeconds % 14400);
      const expiry = new Date(now + secondsLeft * 1000);
      out.earthCycle = {
        id: `earthCycle${Math.round(expiry.getTime() / 60000) * 60000}`,
        activation: iso(expiry.getTime() - 14400000),
        expiry: iso(expiry.getTime()),
        isDay,
        state: isDay ? 'day' : 'night',
        timeLeft: timeLeftStr(secondsLeft * 1000),
      };
    }

    let cetus = null;
    if (Number.isFinite(cetusEndMs)) {
      const endClone = new Date(cetusEndMs);
      endClone.setSeconds(0);
      const secondsToNightEnd = Math.round((endClone.getTime() - now) / 1000);
      const isDay = secondsToNightEnd > 3000;
      const millisLeft = (isDay ? secondsToNightEnd - 3000 : secondsToNightEnd) * 1000;
      const expiry = new Date(Math.round((now + millisLeft) / 60000) * 60000);
      cetus = {
        id: `cetusCycle${expiry.getTime()}`,
        activation: iso(expiry.getTime() - (isDay ? 6000000 : 3000000)),
        expiry: iso(expiry.getTime()),
        isDay,
        state: isDay ? 'day' : 'night',
        timeLeft: timeLeftStr(millisLeft),
        isCetus: true,
      };
      out.cetusCycle = cetus;
      out.cambionCycle = {
        id: `cambionCycle${expiry.getTime()}`,
        activation: cetus.activation,
        expiry: cetus.expiry,
        timeLeft: cetus.timeLeft,
        state: isDay ? 'fass' : 'vome',
      };
      // The Zariman cycle keys off the same bounty-end anchor.
      const endMs = cetusEndMs - 5000;
      const millisLeftZ = endMs - now;
      const elapsed = (((endMs - 1655182800000) % 18000000) + 18000000) % 18000000;
      const isCorpus = 18000000 - elapsed > 9000000;
      const expiryZ = new Date(Math.round((now + millisLeftZ) / 60000) * 60000);
      out.zarimanCycle = {
        id: `zarimanCycle${expiryZ.getTime()}`,
        activation: iso(expiryZ.getTime() - 9000000),
        expiry: iso(expiryZ.getTime()),
        isCorpus,
        state: isCorpus ? 'corpus' : 'grineer',
        timeLeft: timeLeftStr(millisLeftZ),
      };
    }

    {
      const lStart = Date.parse('2026-02-04T19:46:48Z');
      const loopTime = 1600000, coldTime = 1200000;
      const sinceLast = (now - lStart) % loopTime;
      const toNextFull = loopTime - sinceLast;
      const state = toNextFull > coldTime ? 'warm' : 'cold';
      const toNextMinor = toNextFull < coldTime ? toNextFull : toNextFull - coldTime;
      const prev = new Date(now + toNextFull - (state === 'warm' ? loopTime : coldTime));
      prev.setSeconds(0);
      out.vallisCycle = {
        id: `vallisCycle${prev.getTime()}`,
        activation: iso(prev.getTime()),
        expiry: iso(now + toNextMinor),
        isWarm: state === 'warm',
        state,
        timeLeft: timeLeftStr(toNextMinor),
      };
    }

    {
      const states = ['sorrow', 'fear', 'joy', 'anger', 'envy'];
      const cycleDelta = (Math.floor(now / 1000) - 52) % 36000;
      const stateInd = Math.floor(cycleDelta / 7200);
      const untilNext = 7200 - (cycleDelta % 7200);
      const expiry = new Date(now + untilNext * 1000);
      expiry.setSeconds(0); expiry.setMilliseconds(0);
      const activation = new Date(expiry.getTime() - 7200000);
      activation.setSeconds(0); activation.setMilliseconds(0);
      const rawChoices = arr(obj(arr(ws.EndlessXpSchedule)[0]).CategoryChoices);
      out.duviriCycle = {
        id: `duviriCycle${states[stateInd]}${expiry.getTime()}`,
        activation: iso(activation.getTime()),
        expiry: iso(expiry.getTime()),
        state: states[stateInd],
        choices: rawChoices.map((c) => ({
          category: c.Category === 'EXC_HARD' ? 'hard' : 'normal',
          categoryKey: c.Category,
          choices: arr(c.Choices),
        })),
      };
    }

    /* ---------- weekly / scheduled sections ---------- */

    // The raw ProjectPct is authoritative: Tenno Tracker's precomputed
    // constructionProgress was observed serving [0, 0, 0] while the raw
    // values in the same payload were live (2026-10-30), so the relay's
    // field is only a fallback for a payload missing the raw array.
    const pct = arr(ws.ProjectPct).length
      ? arr(ws.ProjectPct) : arr(live.constructionProgress && live.constructionProgress.ProjectPct);
    out.constructionProgress = {
      fomorianProgress: (pct[0] ?? 0).toFixed(2),
      razorbackProgress: (pct[1] ?? 0).toFixed(2),
      unknownProgress: (pct[2] ?? 0).toFixed(2),
    };

    if (ws.SeasonInfo) {
      const si = ws.SeasonInfo;
      let params = {};
      try { params = JSON.parse(si.Params || '{}'); } catch { params = {}; }
      out.nightwave = {
        id: `nightwave${rawMs(si.Expiry)}`,
        activation: iso(rawMs(si.Activation)),
        expiry: iso(rawMs(si.Expiry)),
        season: si.Season,
        tag: humanize(si.AffiliationTag),
        phase: si.Phase,
        params,
        possibleChallenges: [],
        activeChallenges: arr(si.ActiveChallenges).map((c) => {
          const info = obj(challenges[c.Challenge]);
          const isDaily = !!c.Daily;
          const isElite = /hard/i.test(String(c.Challenge || ''));
          const nameKey = info.name || '';
          const descKey = info.description
            || (nameKey.endsWith('_Name') ? `${nameKey.slice(0, -5)}_Description` : '');
          return {
            id: `${rawMs(c.Expiry)}${String(c.Challenge || '').split('/').pop().toLowerCase()}`,
            activation: iso(rawMs(c.Activation)),
            expiry: iso(rawMs(c.Expiry)),
            isDaily,
            isElite,
            desc: descKey ? cleanText(lang(descKey) ?? '', info.requiredCount) : '',
            title: nameKey ? cleanText(lang(nameKey) ?? humanize(c.Challenge), info.requiredCount) : humanize(c.Challenge),
            icon: iconUrl(info.icon),
            reputation: info.standing != null
              ? info.standing
              : 1000 + (!isDaily ? 3500 : 0) + (isElite ? 2500 : 0),
            isPermanent: !!c.Permanent,
          };
        }),
      };
    }

    // Kuva missions come from an external log in the old pipeline, not
    // from the raw feed; there is nothing honest to fill in here.
    out.kuva = [];

    // Timetable picks (arbitration, incursions) are judged at the
    // viewer's wall clock, not the payload's timestamp: the schedules
    // are fixed timetables and the windows carry hours of future
    // entries, while the relayed data can lag minutes behind a
    // rollover — anchoring the pick to the data's time showed the
    // just-started mission as "upcoming" with an ended timer. The
    // pick falls back to the window's first entry when the viewer's
    // clock precedes it. Feed-driven sections still show what the
    // feed says; only these timetable picks use the wall clock.
    const nowSec = Math.floor(Date.now() / 1000);
    const pickCurrent = (sched) => {
      let idx = -1;
      for (let i = 0; i < sched.length; i++) {
        if (sched[i][0] <= nowSec) idx = i;
        else break;
      }
      return idx < 0 && sched.length ? 0 : idx;
    };

    // Arbitration: the relay payload carries a window of the source's
    // own rotation schedule. The entry current at the viewer's now is
    // the live arbitration; the entries after it are exposed in order
    // as arbitrationUpcoming. Node details come from the region
    // table. Without a schedule there is no arbitration.
    {
      const sched = arr(obj(live.staticData).arbysSchedule);
      const arbOf = (e, expirySec) => {
        const region = obj(regions[e[1]]);
        const type = missionTypeName(region.missionType);
        const node = nodeName(e[1]);
        return {
          id: `arbitration${e[0]}`,
          node,
          nodeKey: node,
          activation: iso(e[0] * 1000),
          expiry: iso(expirySec * 1000),
          enemy: factionName(region.faction),
          type,
          typeKey: type,
          tier: obj(statics.arbyTiers)[e[1]],
          archwing: false,
          sharkwing: false,
          expired: false,
        };
      };
      const curIdx = pickCurrent(sched);
      if (curIdx >= 0) {
        const endAt = (i) => (sched[i + 1] ? sched[i + 1][0] : sched[i][0] + 3600);
        out.arbitration = arbOf(sched[curIdx], endAt(curIdx));
        out.arbitrationUpcoming = sched.slice(curIdx + 1, curIdx + 10)
          .map((e, j) => arbOf(e, endAt(curIdx + 1 + j)));
      }
    }

    // Steel Path: the daily incursions come from the source's own
    // incursions schedule — each entry's second field is that day's
    // comma-joined node list, exposed resolved as incursionsDays
    // (current day first, in order). The weekly Teshin honors
    // rotation comes from the reference table, indexed by the parser's
    // anchor math — an 8-week cycle anchored at 2020-11-16T00:00Z,
    // weeks running Monday 00:00 UTC to Sunday 23:59:59 UTC — evaluated
    // at the viewer's now, like the other timetable picks.
    {
      const sched = arr(obj(live.staticData).incursionsSchedule);
      const curIdx = pickCurrent(sched);
      const cur = curIdx >= 0 ? sched[curIdx] : null;
      const rotation = arr(steelPathData.rotation);
      if (cur || rotation.length) {
        out.steelPath = {};
        if (cur) {
          out.steelPath.expiry = iso((cur[0] + 86400) * 1000);
          out.steelPath.incursions = {
            activation: iso(cur[0] * 1000),
            expiry: iso((cur[0] + 86400) * 1000),
          };
          out.steelPath.incursionsDays = sched.slice(curIdx, curIdx + 7).map((e) => ({
            activation: iso(e[0] * 1000),
            expiry: iso((e[0] + 86400) * 1000),
            nodes: String(e[1] || '').split(',').filter(Boolean).map((code) => nodeName(code)),
          }));
        }
        if (rotation.length) {
          const anchorSec = 1605398400; // 2020-11-16T00:00:00Z
          const elapsed = (((nowSec - anchorSec) % 4838400) + 4838400) % 4838400;
          const ind = Math.floor(elapsed / 604800);
          const d = new Date(nowSec * 1000);
          const mondayMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(),
            d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
          const expiryMs = mondayMs + 604800000 - 1000;
          out.steelPath.currentReward = rotation[ind % rotation.length];
          out.steelPath.rotation = rotation;
          out.steelPath.evergreens = arr(steelPathData.evergreen);
          out.steelPath.activation = iso(mondayMs);
          out.steelPath.expiry = iso(expiryMs);
          out.steelPath.remaining = timeLeftStr(expiryMs - now);
        }
      }
    }

    out.archimedeas = arr(ws.Conquests).map((cq) => {
      const condName = (k) => lang(`/Lotus/Language/Conquest/Condition_${k}`) ?? humanize(k);
      const condDesc = (k) => lang(`/Lotus/Language/Conquest/Condition_${k}_Desc`) ?? '';
      return {
        id: `${cq.Type}${rawMs(cq.Activation)}`,
        activation: iso(rawMs(cq.Activation)),
        expiry: iso(rawMs(cq.Expiry)),
        type: { CT_LAB: 'Deep Archimedea', CT_HEX: 'Temporal Archimedea' }[cq.Type] ?? humanize(cq.Type),
        typeKey: cq.Type,
        missions: arr(cq.Missions).map((m) => {
          const diffs = arr(m.difficulties);
          const normal = obj(diffs[0]);
          const risks = arr(normal.risks).map((r) => ({
            key: r, name: condName(r), description: condDesc(r), isHard: false,
          }));
          for (const diff of diffs.slice(1)) {
            for (const r of arr(diff.risks).slice(1)) {
              risks.push({ key: r, name: condName(r), description: condDesc(r), isHard: diff.type === 'CD_HARD' });
            }
          }
          const faction = factionName(m.faction);
          const mt = missionTypeName(m.missionType);
          return {
            faction,
            factionKey: faction,
            missionType: mt,
            missionTypeKey: mt,
            deviation: { key: normal.deviation, name: condName(normal.deviation), description: condDesc(normal.deviation) },
            risks,
          };
        }),
        personalModifiers: arr(cq.Variables).map((v) => ({
          key: v,
          name: lang(`/Lotus/Language/Conquest/PersonalMod_${v}`) ?? humanize(v),
          description: lang(`/Lotus/Language/Conquest/PersonalMod_${v}_Desc`) ?? '',
        })),
      };
    });

    {
      const dz = arr(ws.Descents)[0];
      if (dz) {
        out.descendia = {
          id: `descendia${rawMs(dz.Activation)}`,
          activation: iso(rawMs(dz.Activation)),
          expiry: iso(rawMs(dz.Expiry)),
          seed: dz.RandSeed,
          challenges: arr(dz.Challenges).map((c) => ({
            index: c.Index,
            type: humanize(c.Type),
            typeKey: c.Type,
            challenge: humanize(c.Challenge),
            challengeKey: c.Challenge,
            level: humanize(c.Level),
            levelUniqueName: c.Level,
            specs: arr(c.Specs).map((s) => ({ uniqueName: s, name: humanize(s) })),
            auras: arr(c.Auras).map((a) => ({ uniqueName: a, name: humanize(a) })),
          })),
        };
      }
    }

    {
      const cal = arr(ws.KnownCalendarSeasons)[0];
      if (cal) {
        const dayEvent = (ev) => {
          const e = { type: { CET_CHALLENGE: 'To Do', CET_UPGRADE: 'Hex Override', CET_REWARD: 'Prize', CET_PLOT: 'Hex Birthday' }[ev.type] ?? humanize(ev.type) };
          const describe = (path) => {
            const info = obj(challenges[path]);
            return {
              title: info.name ? cleanText(lang(info.name) ?? humanize(path), info.requiredCount) : humanize(path),
              description: info.description ? cleanText(lang(info.description) ?? '', info.requiredCount) : '',
              icon: iconUrl(info.icon),
            };
          };
          if (ev.challenge) e.challenge = describe(ev.challenge);
          if (ev.upgrade) e.upgrade = describe(ev.upgrade);
          if (ev.reward) {
            e.reward = itemName(ev.reward);
            e.uniqueName = ev.reward;
            const c99 = cal99(ev.reward);
            if (c99 && c99.description) e.description = c99.description;
          }
          return e;
        };
        out.calendar = {
          activation: iso(rawMs(cal.Activation)),
          expiry: iso(rawMs(cal.Expiry)),
          season: humanize(String(cal.Season || '').replace(/^CST_/, '')),
          yearIteration: cal.YearIteration,
          version: cal.Version,
          requirements: cal.UpgradeAvaliabilityRequirements,
          days: arr(cal.Days).filter(Boolean).map((d) => ({
            date: iso(Date.UTC(1999, 0, 1) + (d.day - 1) * 86400000),
            events: arr(d.events).map(dayEvent),
          })),
        };
      }
    }

    // Tmp is a JSON string carrying the Kinepage message (pgr) and the
    // Faceoff bonus window (fbst, epoch seconds).
    {
      let tmp = {};
      try { tmp = JSON.parse(ws.Tmp || '{}'); } catch { tmp = {}; }
      if (tmp.pgr) {
        const { ts, ...translations } = tmp.pgr;
        out.kinepage = {
          timestamp: iso(Number(ts) * 1000),
          message: tmp.pgr.en || '',
          translations,
        };
      }
      if (tmp.fbst) {
        out.faceoffBonus = {
          activation: iso(tmp.fbst.a * 1000),
          expiry: iso(tmp.fbst.e * 1000),
          next: iso(tmp.fbst.n * 1000),
        };
      }
    }

    {
      const cw = arr(ws.WeeklyVaultBonusRewards)[0];
      if (cw) {
        const { activation, expiry } = weeklyReset(now);
        out.clanWeeklyInitiative = {
          activation: iso(activation.getTime()),
          expiry: iso(expiry.getTime()),
          week: cw.WeekCount,
          bonusRegion: langStr(cw.BonusRegion),
          regionUniqueName: cw.BonusRegion,
          rewwards: arr(cw.Rewards),
        };
      }
    }

    // Prime Access contents exist in no feed (the raw feed carries
    // only an availability flag); they come from the reference
    // snapshot's WARFRAME Wiki extraction.
    out.primeAccess = (ref && ref.primeAccess) || null;

    return out;
  }

  global.translateWorldState = translateWorldState;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { translateWorldState };
  }
})(typeof window !== 'undefined' ? window : globalThis);
