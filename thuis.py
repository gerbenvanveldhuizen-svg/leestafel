"""Thuisaanvulling voor De Leestafel: haalt op deze pc de bronnen op die GitHub-servers weigeren (BNR, Carlita Shaw).

Draait via de Windows-taakplanner, zonder Claude. Zet de berichten versleuteld op de GitHub-tak `thuis`
en start daarna een verse editie. Staat de pc uit, dan gebruikt GitHub de laatste thuisaanvulling.

Gebruik:  python thuis.py
"""
import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HIER = Path(__file__).resolve().parent
os.environ["LEESTAFEL_UIT"] = str(HIER / "uit-thuis")
sys.path.insert(0, str(HIER))
import haal_feeds  # noqa: E402
import bouw  # noqa: E402

REPO = "https://github.com/gerbenvanveldhuizen-svg/leestafel.git"
GH = r"C:\Program Files\GitHub CLI\gh.exe"
LOG = HIER / "uit-thuis" / "thuis.log"
GEEN_VENSTER = 0x08000000 if os.name == "nt" else 0  # geen zwarte vensters vanuit de taakplanner


def thuis_feeds():
    return [f for f in haal_feeds.FEEDS if f[0] == "bnr" or "carlitashaw" in f[2]]


def run(cmd, cwd=None):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, creationflags=GEEN_VENSTER)


def log(regel):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    stempel = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    with LOG.open("a", encoding="utf-8") as f:
        f.write(f"{stempel} {regel}\n")
    print(regel)


def main():
    uit = Path(os.environ["LEESTAFEL_UIT"])
    uit.mkdir(parents=True, exist_ok=True)
    for oud in uit.glob("feeds_*.json"):
        oud.unlink()  # alleen verse thuisberichten meesturen
    haal_feeds.FEEDS = thuis_feeds()
    haal_feeds.main()

    items = []
    for f in sorted(uit.glob("feeds_*.json")):
        items.extend(json.loads(f.read_text(encoding="utf-8")).get("items", []))
    fouten = json.loads((uit / "status.json").read_text(encoding="utf-8")).get("errors", [])
    if not items:
        log(f"niets opgehaald, fouten: {[e.get('bron') for e in fouten]}")
        return

    nu = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    ruw = json.dumps({"updatedAt": nu, "items": items}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    pakket = bouw.versleutel(ruw, bouw.leid_sleutel_af(bouw.sleutel_wachtwoord()))
    pakket["updatedAt"] = nu

    # Tak `thuis` heeft altijd precies één commit, zodat de repository niet groeit.
    tmp = Path(tempfile.mkdtemp(prefix="leestafel-thuis-"))
    try:
        (tmp / "thuis.json").write_text(json.dumps(pakket, separators=(",", ":")), encoding="utf-8")
        for cmd in (["git", "init", "-q", "-b", "thuis"],
                    ["git", "config", "user.name", "Gerben van Veldhuizen"],
                    ["git", "config", "user.email", "324201751+gerbenvanveldhuizen-svg@users.noreply.github.com"],
                    ["git", "add", "thuis.json"],
                    ["git", "commit", "-q", "-m", f"Thuisaanvulling {nu}"],
                    ["git", "push", "-q", "--force", REPO, "thuis"]):
            r = run(cmd, cwd=tmp)
            if r.returncode != 0:
                log(f"git mislukt ({' '.join(cmd[:2])}): {r.stderr.strip()[:200]}")
                return
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    r = run([GH, "workflow", "run", "ververs.yml", "--repo", "gerbenvanveldhuizen-svg/leestafel"])
    status = "editie gestart" if r.returncode == 0 else f"editie starten mislukt: {r.stderr.strip()[:150]}"
    log(f"{len(items)} berichten thuis opgehaald en verstuurd; {status}; fouten: {[e.get('bron') for e in fouten]}")


if __name__ == "__main__":
    main()
