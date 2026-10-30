#!/usr/bin/env python3
"""Fetch the Tenno Tracker API payload, extract its staticData section
without the two schedule tables, validate it, and write it as a
canonical JSON file. Run by the static-data GitHub Action; also
runnable by hand:

    python3 tools/fetch-static-data.py [output-path]

Fails closed: if the payload is missing or the static tables look
gutted, it exits nonzero and writes nothing, so a bad pull can never
replace the last good snapshot.
"""
import json
import sys
import urllib.request

URL = "https://api.tennotracker.com/api/worldstate"
DROP = ("arbysSchedule", "incursionsSchedule")
MIN_DICT_ENTRIES = 10000


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "static-data.json"
    req = urllib.request.Request(URL, headers={"User-Agent": "world-dash-static"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.load(resp)
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
