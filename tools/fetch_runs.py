"""Download contributed runs from the collection Worker into tests/data/runs/.

Reads the Worker URL from config.json (uploadUrl) and the admin token from
secrets/runs-admin-token.txt. Only runs not already downloaded are fetched.
Then open tests/dataset.html (served with `python -m http.server`) to re-score them.

Usage:  python tools/fetch_runs.py
"""
import gzip
import json
import pathlib
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "data" / "runs"


def get(url, token):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def main():
    base = json.loads((ROOT / "config.json").read_text(encoding="utf-8")).get("uploadUrl", "").rstrip("/")
    if not base:
        sys.exit("config.json has no uploadUrl yet")
    token = (ROOT / "secrets" / "runs-admin-token.txt").read_text(encoding="utf-8").strip()
    OUT.mkdir(parents=True, exist_ok=True)

    index_path = OUT / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []
    have = {r["id"] for r in index}

    try:
        runs = json.loads(get(f"{base}/v1/runs", token))["runs"]
    except urllib.error.HTTPError as e:
        sys.exit(f"listing failed: HTTP {e.code} {e.read().decode(errors='replace')}")

    new = [r for r in runs if r["id"] not in have]
    for r in new:
        csv = gzip.decompress(get(f"{base}/v1/runs/{r['id']}/csv", token))
        (OUT / f"{r['id']}.csv").write_bytes(csv)
        r["meta"] = json.loads(r["meta"]) if r.get("meta") else None
        r["warnings"] = json.loads(r["warnings"]) if r.get("warnings") else []
        index.append(r)
        print("downloaded", r["id"], r.get("route") or "", r.get("device") or "")

    index.sort(key=lambda r: r["created_at"])
    index_path.write_text(json.dumps(index, indent=1), encoding="utf-8")
    print(f"{len(new)} new, {len(index)} total runs in {OUT}")


if __name__ == "__main__":
    main()
