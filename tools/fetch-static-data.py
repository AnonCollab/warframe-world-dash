#!/usr/bin/env python3
"""Fetch the Tenno Tracker API payload, extract its staticData section
without the two schedule tables, validate it, and write it as a
canonical JSON file. Run by the static-data GitHub Action; also
runnable by hand:

    python3 tools/fetch-static-data.py [output-path]

Fails closed: if the payload is missing or the static tables look
gutted, it exits nonzero and writes nothing, so a bad pull can never
replace the last good snapshot.

Capture-on-sight: two feed sections (global upgrades, persistent
enemies) are empty almost all of the time, so when a pull DOES catch
them active, the raw worldState is saved to
fixtures/last-seen-active.json — a real capture for later translator
work, committed by the same workflow.
"""
import datetime
import json
import os
import sys
import urllib.request

URL = "https://api.tennotracker.com/api/worldstate"
DROP = ("arbysSchedule", "incursionsSchedule")
MIN_DICT_ENTRIES = 10000
CAPTURE_PATH = os.path.join("fixtures", "last-seen-active.json")


def capture_on_sight(data):
    ws = data.get("worldState")
    if not isinstance(ws, dict):
        return
    if not ws.get("GlobalUpgrades") and not ws.get("PersistentEnemies"):
        return
    stamp = ws.get("Time")
    captured = {
        "capturedAt": datetime.datetime.fromtimestamp(
            stamp, tz=datetime.UTC
        ).isoformat() if isinstance(stamp, (int, float)) else None,
        "worldState": ws,
    }
    os.makedirs(os.path.dirname(CAPTURE_PATH), exist_ok=True)
    with open(CAPTURE_PATH, "w", encoding="utf-8") as f:
        json.dump(captured, f, sort_keys=True, ensure_ascii=False)
    print(f"capture-on-sight: wrote {CAPTURE_PATH}")


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "static-data.json"
    req = urllib.request.Request(URL, headers={"User-Agent": "world-dash-static"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.load(resp)
    capture_on_sight(data)
    static = data.get("staticData")
    if not isinstance(static, dict):
        sys.exit("payload has no staticData object; refusing to write")
    for key in DROP:
        static.pop(key, None)
    dictionary = static.get("dict")
    if not isinstance(dictionary, dict) or len(dictionary) < MIN_DICT_ENTRIES:
        sys.exit("dict table missing or suspiciously small; refusing to write")
    for key in ("regions", "challenges", "osdict", "missionTypes", "factions"):
        if key not in static:
            sys.exit(f"staticData missing {key}; refusing to write")
    blob = json.dumps(
        static, sort_keys=True, separators=(",", ":"), ensure_ascii=False
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
        f"dict {len(dictionary):,} entries, "
        f"keys {sorted(static.keys())}"
    )


if __name__ == "__main__":
    main()
