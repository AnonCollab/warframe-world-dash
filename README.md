# WorldDash — Warframe World State Dashboard

A single-page world state dashboard for Warframe, showing everything the
live world state feed offers in one place, organized into tabs:

- **Overview** — world cycles (Earth, Cetus, Orb Vallis, Cambion Drift,
  Zariman, Duviri mood), Fomorian / Razorback construction, trader and
  daily highlights
- **Alerts & Events** — alerts with full rewards, timed events with
  progress, and the news feed
- **Fissures** — Void Fissures split into Normal / Steel Path / Void Storms,
  with tier and mission-type filters
- **Invasions** — progress, both sides' battle pay, and a rate-based
  completion estimate
- **Sortie & Archon** — daily Sortie, Archon Hunt, and Arbitration status
- **Weekly** — Nightwave acts, The Circuit, Steel Path honors rotation,
  Archimedea, Descendia, the 1999 calendar, Faceoff bonus, and the clan
  weekly initiative
- **Bounties** — syndicate missions, open-world bounties with reward pools,
  and Conclave challenges
- **Traders & Market** — Baro Ki'Teer's inventory with prices, Varzia's
  Prime Resurgence manifest, Darvo's daily deal, and searchable flash sales
- **More** — Acolytes, the Synthesis target, global upgrades, dark sectors,
  and the Höllvania radio message

Live site: https://anoncollab.github.io/warframe-world-dash/

## How it works

Plain HTML, CSS, and JavaScript — no framework, no build step. The page
fetches the raw world state feed through a small relay every five minutes
and translates it in the browser (`translate.js`), using reference tables
in `static-data.json` (the game's language strings and node data) and
`reference-data.json` (bounty reward pools, sortie data, the Steel Path
rotation, conclave challenges). Both table files are refreshed weekly by
a GitHub Action. Countdowns tick locally once per second. Sections whose
data is empty say so instead of disappearing.

The layout is registry-driven: tabs and sections are declared in two lists
in `app.js`, and the page skeleton is generated from them. Moving a section
to another tab is a one-line change to its registry entry.

## Data sources and credit

- World state data originates from Digital Extremes' official world state
  feed for Warframe. Live data reaches the page via the Tenno Tracker API,
  relayed by a small Cloudflare Worker that adds CORS headers and a short
  edge cache; the raw feed is translated locally in the browser.
- The static tables in `static-data.json` (language strings, node data,
  challenge definitions) come from Tenno Tracker.
- The reward decks in `reference-data.json` (bounty reward pools) come
  from browse.wf's `warframe-public-export-plus` (by calamity-inc),
  keyed by the exact deck paths the live feed carries; the item names
  for those decks come from the Warframe Community Developers (WFCD)
  `warframe-items` data.
- The remaining reference tables in `reference-data.json` — sortie
  bosses and modifiers, the Steel Path honors rotation, conclave
  challenges, synthesis targets — come from WFCD open data
  (`warframe-worldstate-data`).
- Item icons are served by the WFCD item CDN.
- The arbitration and Steel Path incursion schedules are computed from
  the Tenno Tracker payload's published schedules; the dashboard says so
  honestly when no schedule is available.

## Disclaimer

Unofficial fan project. Not affiliated with or endorsed by Digital
Extremes. Warframe and all game content are property of Digital Extremes
Ltd.
