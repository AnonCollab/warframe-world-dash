#!/usr/bin/env python3
"""Fetch the open-data reference tables the dashboard joins against
the live feed (reward decks, sortie bosses/modifiers, the Steel Path
rotation, conclave challenges, synthesis targets, acolyte regions,
global-upgrade names), validate them, and write ONE canonical
reference-data.json. Run by the static-data GitHub Action alongside
fetch-static-data.py; also runnable by hand:

    python3 tools/fetch-reference-data.py [output-path]

Sources:
  - browse.wf (warframe-public-export-plus): ExportRewards.json — the
    reward decks, keyed by the exact deck path the live feed's jobs
    carry. Only the MissionDecks decks are kept.
  - WFCD/warframe-items: item display names (uniqueName -> name),
    reduced here to just the paths those decks can drop.
  - WFCD/warframe-worldstate-data: sortieData, steelPath, conclaveData,
    synthTargets, persistentEnemyData, upgradeTypes, and languages.json
    (only its synthesis research-target entries are kept — the full
    language table already reaches the dashboard via static-data.json)

Fails closed: any fetch or validation failure exits nonzero and writes
nothing, so a bad pull can never replace the last good snapshot.
"""
import json
import re
import sys
import urllib.request

RAW = "https://raw.githubusercontent.com/WFCD/{repo}/master/data/{name}"
WORLDSTATE_DATA = "warframe-worldstate-data"
ITEMS_API = "https://api.github.com/repos/WFCD/warframe-items/contents/data/json"
ITEMS_RAW = "https://raw.githubusercontent.com/WFCD/warframe-items/master/data/json/{name}"
EXPORT_REWARDS = "https://browse.wf/warframe-public-export-plus/ExportRewards.json"

RESEARCH_TARGET = re.compile(
    r"^/lotus/types/game/library/targets/research(\d+)target$"
)


def fetch_json_url(url):
    req = urllib.request.Request(url, headers={"User-Agent": "world-dash-reference"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.load(resp)


def fetch_json(repo, name):
    return fetch_json_url(RAW.format(repo=repo, name=name))


def fail(msg):
    sys.exit(f"{msg}; refusing to write")


def reward_decks():
    data = fetch_json_url(EXPORT_REWARDS)
    if not isinstance(data, dict):
        fail("ExportRewards.json: not a JSON object")
    decks = {k: v for k, v in data.items() if "/MissionDecks/" in k}
    if len(decks) < 500:
        fail(f"ExportRewards.json: only {len(decks)} MissionDecks decks")
    for key, rotations in decks.items():
        # Entries come in two forms: probability-weighted, and
        # rarity-tiered ({type, itemCount, rarity}) — both are real.
        if not isinstance(rotations, list) or not rotations \
                or any(not isinstance(r, list) for r in rotations) \
                or any(not isinstance(e, dict) or "type" not in e
                       or ("probability" not in e and "rarity" not in e)
                       for r in rotations for e in r):
            fail(f"ExportRewards.json: malformed deck {key}")
    return decks


def usable_name(item):
    # A few warframe-items entries (the Endo fusion bundles, some
    # Ayatan variants) carry a mangled name: the path tail with its
    # capitals flattened ("Uncommonfusionbundle"). Those are worse
    # than the dashboard's humanized-path fallback, so drop them.
    name, unique = item.get("name"), item.get("uniqueName")
    if not name or not unique:
        return None
    tail = unique.rsplit("/", 1)[-1]
    if name != tail and name.lower() == tail.lower() \
            and any(c.isupper() for c in tail[1:]):
        return None
    return name


def item_names(decks):
    # warframe-items uniqueNames are the deck paths with the
    # "/StoreItems" segment removed; resolve under both forms and keep
    # only the names for paths these decks can actually drop.
    needed = {e["type"] for rotations in decks.values()
              for r in rotations for e in r}
    listing = fetch_json_url(ITEMS_API)
    if not isinstance(listing, list):
        fail("warframe-items: category listing unavailable")
    by_unique = {}
    for entry in listing:
        name = entry.get("name") if isinstance(entry, dict) else None
        if not name or not name.endswith(".json"):
            continue
        for item in fetch_json_url(ITEMS_RAW.format(name=name)):
            if isinstance(item, dict) and item.get("uniqueName"):
                hit = usable_name(item)
                if hit:
                    by_unique[item["uniqueName"]] = hit
    if len(by_unique) < 10000:
        fail(f"warframe-items: only {len(by_unique)} named items parsed")
    out = {}
    for path in needed:
        hit = by_unique.get(path) or by_unique.get(
            path.replace("/StoreItems/", "/", 1))
        if hit:
            out[path] = hit
    if len(out) < 1000:
        fail(f"warframe-items: only {len(out)} deck item names resolved")
    return out


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "reference-data.json"

    out = {}
    decks = reward_decks()
    out["bountyRewards"] = decks
    out["itemNames"] = item_names(decks)

    sortie = fetch_json(WORLDSTATE_DATA, "sortieData.json")
    if not isinstance(sortie, dict) \
            or not isinstance(sortie.get("bosses"), dict) or len(sortie["bosses"]) < 10 \
            or not isinstance(sortie.get("modifierTypes"), dict) \
            or len(sortie["modifierTypes"]) < 10 \
            or not isinstance(sortie.get("modifierDescriptions"), dict) \
            or len(sortie["modifierDescriptions"]) < 10:
        fail("sortieData.json: bosses/modifier tables missing or suspiciously small")
    out["sortieData"] = sortie

    steel = fetch_json(WORLDSTATE_DATA, "steelPath.json")
    if not isinstance(steel, dict) \
            or not isinstance(steel.get("rotation"), list) or len(steel["rotation"]) < 4 \
            or not isinstance(steel.get("evergreen"), list) or not steel["evergreen"] \
            or any(not isinstance(r, dict) or "name" not in r or "cost" not in r
                   for r in steel["rotation"]):
        fail("steelPath.json: rotation/evergreen missing or malformed")
    out["steelPath"] = steel

    conclave = fetch_json(WORLDSTATE_DATA, "conclaveData.json")
    if not isinstance(conclave, dict) \
            or not isinstance(conclave.get("challenges"), dict) \
            or len(conclave["challenges"]) < 20 \
            or not isinstance(conclave.get("modes"), dict) \
            or not isinstance(conclave.get("categories"), dict):
        fail("conclaveData.json: challenge/mode/category tables missing or too small")
    out["conclaveData"] = conclave

    synth = fetch_json(WORLDSTATE_DATA, "synthTargets.json")
    if not isinstance(synth, list) or len(synth) < 30 \
            or any(not isinstance(t, dict) or "name" not in t for t in synth):
        fail("synthTargets.json: target list missing or malformed")
    out["synthTargets"] = synth

    acolytes = fetch_json(WORLDSTATE_DATA, "persistentEnemyData.json")
    if not isinstance(acolytes, dict) \
            or not isinstance(acolytes.get("regions"), list) \
            or len(acolytes["regions"]) < 10:
        fail("persistentEnemyData.json: region table missing or too small")
    out["persistentEnemyData"] = acolytes

    upgrades = fetch_json(WORLDSTATE_DATA, "upgradeTypes.json")
    if not isinstance(upgrades, dict) or len(upgrades) < 4 \
            or any(not isinstance(v, dict) or "value" not in v
                   for v in upgrades.values()):
        fail("upgradeTypes.json: upgrade table missing or malformed")
    out["upgradeTypes"] = upgrades

    # The synthesis research targets are numbered in the feed
    # (…/Targets/Research7Target) and named only in the language table;
    # extract just those entries. The names are cross-checked against
    # synthTargets' "[Research]" entries by the build checks.
    languages = fetch_json(WORLDSTATE_DATA, "languages.json")
    if not isinstance(languages, dict) or len(languages) < 1000:
        fail("languages.json: language table missing or suspiciously small")
    targets = {}
    for key, entry in languages.items():
        m = RESEARCH_TARGET.match(key)
        if m and isinstance(entry, dict) and entry.get("value"):
            targets[m.group(1)] = entry["value"]
    if len(targets) < 7:
        fail("languages.json: synthesis research targets not found")
    out["simarisTargets"] = targets

    blob = json.dumps(
        out, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    try:
        with open(out_path, "rb") as f:
            if f.read() == blob:
                print(f"unchanged: {out_path} ({len(blob):,} bytes)")
                return
    except FileNotFoundError:
        pass
    with open(out_path, "wb") as f:
        f.write(blob)
    print(
        f"wrote {out_path}: {len(blob):,} bytes, "
        f"reward decks {len(decks)}, item names {len(out['itemNames'])}, "
        f"simaris targets {len(targets)}"
    )


if __name__ == "__main__":
    main()
