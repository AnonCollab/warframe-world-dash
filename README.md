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
- **Sortie & Archon** — daily Sortie, Archon Hunt, Arbitration status, and
  Kuva missions when listed
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
in `static-data.json` (the game's language strings, node data, and the
arbitration and Steel Path incursion schedules). Countdowns tick locally
once per second. Sections whose data is empty say so instead of
disappearing.

The layout is registry-driven: tabs and sections are declared in two lists
in `app.js`, and the page skeleton is generated from them. Moving a section
to another tab is a one-line change to its registry entry.

## Data sources and credit

- World state data originates from Digital Extremes' official world state
  feed for Warframe; the raw feed is relayed by a third-party mirror and
  parsed locally in the browser.
- Item icons are served by the Warframe Community Developers (WFCD) item
  CDN.
- The arbitration rotation is computed from the source's published
  schedule, carried with the relay payload; the dashboard says so honestly
  when no schedule is available.

## Disclaimer

Unofficial fan project. Not affiliated with or endorsed by Digital
Extremes. Warframe and all game content are property of Digital Extremes
Ltd.
