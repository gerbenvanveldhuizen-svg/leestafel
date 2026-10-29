"""Bouwt de editie van De Leestafel: haalt alle bronnen op en schrijft één versleuteld databestand.

Gebruik:  python bouw.py
Sleutel:  omgevingsvariabele LEESTAFEL_SLEUTEL, anders het bestand geheim/sleutel.txt.
Uitvoer:  site/data/nieuws.json  (versleuteld met AES-256-GCM; de app ontsleutelt op het apparaat)

Op GitHub draait dit drie keer per dag via .github/workflows/ververs.yml.
"""
import base64
import datetime
import hashlib
import json
import os
import secrets
import sys
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

HIER = Path(__file__).resolve().parent
os.environ.setdefault("LEESTAFEL_UIT", str(HIER / "uit"))
sys.path.insert(0, str(HIER))
import haal_feeds  # noqa: E402

# Vast en openbaar: het zout hoeft niet geheim te zijn, het wachtwoord wel.
ZOUT = b"de-leestafel-gerben-2026"
ITERATIES = 200_000
DATA = HIER / "site" / "data" / "nieuws.json"


def sleutel_wachtwoord() -> str:
    w = os.environ.get("LEESTAFEL_SLEUTEL", "").strip()
    if not w:
        f = HIER / "geheim" / "sleutel.txt"
        if f.exists():
            w = f.read_text(encoding="utf-8").strip()
    if not w:
        sys.exit("Geen sleutel: zet LEESTAFEL_SLEUTEL of maak geheim/sleutel.txt")
    return w


def leid_sleutel_af(wachtwoord: str) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", wachtwoord.encode("utf-8"), ZOUT, ITERATIES, dklen=32)


def versleutel(data: bytes, sleutel: bytes) -> dict:
    iv = secrets.token_bytes(12)
    ct = AESGCM(sleutel).encrypt(iv, data, None)
    b64 = lambda b: base64.b64encode(b).decode("ascii")
    return {"v": 1, "iter": ITERATIES, "iv": b64(iv), "ct": b64(ct)}




def main():
    wachtwoord = sleutel_wachtwoord()
    haal_feeds.main()
    uit = Path(os.environ["LEESTAFEL_UIT"])

    items = []
    actief = {f[0] for f in haal_feeds.FEEDS}  # bronnen die eruit zijn gehaald niet meer meenemen
    for f in sorted(uit.glob("feeds_*.json")):
        if f.stem.removeprefix("feeds_") not in actief:
            continue
        doc = json.loads(f.read_text(encoding="utf-8"))
        items.extend(doc.get("items", []))
    items.sort(key=lambda x: x.get("published") or "", reverse=True)

    status = json.loads((uit / "status.json").read_text(encoding="utf-8"))
    fouten = [{"bron": e.get("bron"), "fout": str(e.get("fout", ""))[:120]} for e in status.get("errors", [])]
    items.sort(key=lambda x: x.get("published") or "", reverse=True)
    editie = {
        "updatedAt": status.get("updatedAt"),
        "counts": status.get("counts", {}),
        "errors": fouten,
        "items": items,
    }
    ruw = json.dumps(editie, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    pakket = versleutel(ruw, leid_sleutel_af(wachtwoord))
    pakket["updatedAt"] = editie["updatedAt"]  # openbaar: alleen het tijdstip
    DATA.parent.mkdir(parents=True, exist_ok=True)
    DATA.write_text(json.dumps(pakket, separators=(",", ":")), encoding="utf-8")
    print(f"editie klaar: {len(items)} berichten, {len(ruw)//1024} KB ruw, "
          f"{DATA.stat().st_size//1024} KB versleuteld -> {DATA}")
    if editie["errors"]:
        print("let op, bronnen met fouten:", ", ".join(e["bron"] for e in editie["errors"]))


if __name__ == "__main__":
    main()
