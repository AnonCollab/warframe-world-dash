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
  - browse.wf (warframe-public-export-plus): ExportTextIcons.json —
    the damage-type text icons (<DT_*> tags in game strings); only the
    DT_* entries' DIT_AUTO paths are kept.
  - The WARFRAME Wiki (wiki.warframe.com): the Prime Access article's
    "Current Prime Access" template — frame, weapons, accessories and
    start date. Prime Access contents exist in no feed (the raw feed
    carries only an availability flag), so they are extracted from the
    wiki's structured wikitext and validated like everything else.
  - Digital Extremes' Public Export: ExportManifest.json (located via
    the origin server's LZMA index) — the full image manifest. Reduced
    to two icon maps: interface-icon textures by bare path (what the
    feed's Icon fields and the challenge definitions reference) and
    deck-item textures by uniqueName (bounty reward pools).

Fails closed: any fetch or validation failure exits nonzero and writes
nothing, so a bad pull can never replace the last good snapshot.
"""
import http.client
import json
import re
import sys
import urllib.error
import urllib.request

RAW = "https://raw.githubusercontent.com/WFCD/{repo}/master/data/{name}"
WORLDSTATE_DATA = "warframe-worldstate-data"
ITEMS_API = "https://api.github.com/repos/WFCD/warframe-items/contents/data/json"
ITEMS_RAW = "https://raw.githubusercontent.com/WFCD/warframe-items/master/data/json/{name}"
EXPORT_REWARDS = "https://browse.wf/warframe-public-export-plus/ExportRewards.json"
EXPORT_TEXT_ICONS = "https://browse.wf/warframe-public-export-plus/ExportTextIcons.json"
WIKI_API = "https://wiki.warframe.com/api.php"
EXPORT_INDEX = "https://origin.warframe.com/PublicExport/index_en.txt.lzma"
EXPORT_BASE = "https://content.warframe.com/PublicExport/"

RESEARCH_TARGET = re.compile(
    r"^/lotus/types/game/library/targets/research(\d+)target$"
)


def fetch_bytes_url(url, extra_headers=None):
    # One retry on transport errors: chunked responses occasionally
    # truncate mid-stream, and a transient cut should not fail the run.
    # Validation failures are unaffected — they still fail closed.
    headers = {"User-Agent": "world-dash-reference"}
    if extra_headers:
        headers.update(extra_headers)
    last = None
    for _ in range(2):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=300) as resp:
                return resp.read()
        except (urllib.error.URLError, http.client.HTTPException,
                ConnectionError, TimeoutError) as e:
            last = e
    raise last


def fetch_json_url(url, extra_headers=None):
    return json.loads(fetch_bytes_url(url, extra_headers))


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


def text_icons():
    raw = fetch_json_url(EXPORT_TEXT_ICONS)
    if not isinstance(raw, dict) or len(raw) < 100:
        fail("ExportTextIcons.json: table missing or suspiciously small")
    out = {}
    for key, variants in raw.items():
        if key.startswith("DT_") and isinstance(variants, dict):
            path = variants.get("DIT_AUTO")
            if isinstance(path, str) and path.endswith(".png"):
                out[key] = path
    if len(out) < 30:
        fail("ExportTextIcons.json: damage-type icon set missing or too small")
    return out


def _wiki_text(text):
    # [[target|label]] -> label; [[label]] -> label
    text = re.sub(r"\[\[[^|\]]*\|([^\]]*)\]\]", r"\1", text)
    text = re.sub(r"\[\[([^\]]*)\]\]", r"\1", text)
    return text.strip()


def prime_access():
    # Fetch only the "Current Prime Access" section's wikitext: the
    # full article is ~30 KB and large chunked responses truncate
    # mid-stream through some proxies; the section alone is a few KB.
    # Connection: close for the same reason — a closing connection
    # delivers the body whole where keep-alive chunks get cut.
    listing = fetch_json_url(
        WIKI_API + "?action=parse&page=Prime_Access&prop=sections&format=json",
        {"Connection": "close"})
    try:
        index = next(s["index"] for s in listing["parse"]["sections"]
                     if s.get("line") == "Current Prime Access")
    except (KeyError, TypeError, StopIteration):
        fail("wiki Prime Access: current section not listed")
    doc = fetch_json_url(
        WIKI_API + "?action=parse&page=Prime_Access&prop=wikitext"
        f"&section={index}&format=json",
        {"Connection": "close"})
    try:
        section = doc["parse"]["wikitext"]["*"]
    except (KeyError, TypeError):
        fail("wiki Prime Access: unexpected section response shape")
    fields = {}
    for m in re.finditer(
            r"\|(wf|w1|w2|Quote|Available|syandana|armor|a2)\s*=\s*(.*?)"
            r"(?=\n\|[A-Za-z]|\n\}\}|\Z)", section, re.DOTALL):
        fields[m.group(1)] = m.group(2).strip()
    wf = fields.get("wf", "")
    heading = re.search(r"==(.+?)==", section)
    if not wf or not heading or heading.group(1).strip() != f"{wf} Prime":
        fail("wiki Prime Access: frame field missing or heading mismatch")
    weapons = [f"{fields[k]} Prime" for k in ("w1", "w2") if fields.get(k)]
    if not weapons:
        fail("wiki Prime Access: no weapons parsed")
    available_raw = fields.get("Available", "").split(" to ")[0].strip()
    try:
        from datetime import datetime
        available = datetime.strptime(available_raw, "%B %d, %Y").date().isoformat()
    except ValueError:
        fail(f"wiki Prime Access: unparseable Available date {available_raw!r}")
    accessories = []
    if fields.get("syandana"):
        accessories.append(f"{fields['syandana']} Prime Syandana")
    if fields.get("armor"):
        accessories.append(f"{fields['armor']} Prime Armor")
    for part in re.split(r"<br\s*/?>", fields.get("a2", "")):
        name = _wiki_text(part)
        if name:
            accessories.append(name)
    return {
        "frame": f"{wf} Prime",
        "weapons": weapons,
        "accessories": accessories,
        "available": available,
        "quote": _wiki_text(fields.get("Quote", "")),
    }


def icon_manifest(deck_paths):
    import lzma
    index = lzma.decompress(fetch_bytes_url(EXPORT_INDEX)).decode("utf-8")
    entry = next((line.strip() for line in index.splitlines()
                  if line.startswith("ExportManifest.json!")), None)
    if not entry:
        fail("Public Export index: ExportManifest entry not listed")
    doc = fetch_json_url(EXPORT_BASE + "Manifest/" + entry)
    entries = doc.get("Manifest") if isinstance(doc, dict) else None
    if not isinstance(entries, list) or len(entries) < 10000:
        fail("ExportManifest.json: manifest missing or suspiciously small")
    textures = {}
    by_unique = {}
    for e in entries:
        if not isinstance(e, dict):
            continue
        tex = e.get("textureLocation")
        if not isinstance(tex, str) or not tex:
            continue
        if tex.split("!")[0].startswith("/Lotus/Interface/Icons/"):
            textures[tex.split("!")[0]] = tex
        if e.get("uniqueName"):
            by_unique[e["uniqueName"]] = tex
    # Manifest uniqueNames are the deck paths with the "/StoreItems"
    # segment removed (the same dual-form resolution item_names uses).
    items = {}
    for path in deck_paths:
        tex = by_unique.get(path) or by_unique.get(
            path.replace("/StoreItems/", "/", 1))
        if tex:
            items[path] = tex
    if len(textures) < 5000 or len(items) < 500:
        fail("ExportManifest.json: icon maps suspiciously small")
    return textures, items


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

    out["textIcons"] = text_icons()
    out["primeAccess"] = prime_access()

    deck_paths = {drop["type"] for stages in decks.values()
                  for table in stages for drop in table
                  if isinstance(drop, dict) and drop.get("type")}
    textures, item_icons = icon_manifest(deck_paths)
    out["iconTextures"] = textures
    out["itemIcons"] = item_icons

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
