"""Haalt de bronnen voor De Leestafel op en schrijft per bron een JSON-document.

Gebruik:  python haal_feeds.py
Uitvoer:  map `uit/` naast dit script, met feeds_<bron>.json per bron en status.json.
Alleen standaardbibliotheek plus curl (staat standaard op Windows 11).
Nieuwsbrieven komen uit de RSS-feeds van Substack, inclusief volledige tekst.
"""
import os, json, re, html, hashlib, urllib.request, gzip, io, datetime, email.utils, subprocess, time
import xml.etree.ElementTree as ET
from pathlib import Path

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36"
HIER = Path(__file__).resolve().parent
UIT = Path(os.environ.get("LEESTAFEL_UIT", HIER / "uit"))

# (bron-id, bronnaam, url, rubriek, max items)
FEEDS = [
    ("rd",  "Reformatorisch Dagblad", "https://www.rd.nl/rss-feed?slug=laatste-nieuws",   "Laatste nieuws", 25),
    ("rd",  "Reformatorisch Dagblad", "https://www.rd.nl/rss-feed?slug=kerk-and-religie", "Kerk & religie", 10),
    ("rd",  "Reformatorisch Dagblad", "https://www.rd.nl/rss-feed?slug=meditatie",        "Meditatie", 3),
    ("nos", "NOS",                    "https://feeds.nos.nl/nosnieuwsalgemeen",           "NOS", 25),
    ("nd",  "Nederlands Dagblad",     "https://www.nd.nl/rss",                            "Nederlands Dagblad", 20),
    ("nu",  "NU.nl",                  "https://www.nu.nl/rss/Algemeen",                   "Algemeen", 15),
    ("nu",  "NU.nl",                  "https://www.nu.nl/rss/Economie",                   "Economie", 8),
    ("dagaandag", "Dag aan Dag",      "https://dagaandag.com/rss",                        "Dag aan Dag", 20),
    ("nieuwsbrieven", "Cowork Operator", "https://www.coworkoperator.com/feed",          "Substack", 8),
]
BRONNAMEN = {"rd": "Reformatorisch Dagblad", "nos": "NOS", "nd": "Nederlands Dagblad", "bnr": "BNR Nieuwsradio", "nu": "NU.nl",
             "dagaandag": "Dag aan Dag", "nieuwsbrieven": "Nieuwsbrieven"}  # dagaandag.com, reformatorisch platform


def fetch(url: str, wachttijden=(0, 5, 20, 60)) -> bytes:
    """Via curl (BNR weigert Pythons urllib). Feeds krijgen vier pogingen, losse artikelen twee."""
    laatste = None
    for poging, wacht in enumerate(wachttijden):
        if wacht:
            time.sleep(wacht)
        try:
            r = subprocess.run(["curl", "-s", "-L", "--compressed", "--max-time", "25", "-A", UA,
                                "-H", "Accept: */*", "-H", "Accept-Language: nl-NL,nl;q=0.9",
                                "-H", "Cache-Control: no-cache", "-w", "\n%{http_code}", url],
                               capture_output=True, check=True,
                               creationflags=0x08000000 if os.name == "nt" else 0)  # geen vensters op Windows
            data, _, code = r.stdout.rpartition(b"\n")
            if not code.isdigit() or int(code) >= 400:
                raise RuntimeError(f"HTTP {code.decode(errors='ignore')}")
            break
        except Exception as e:
            laatste = e
    else:
        raise RuntimeError(f"ophalen mislukt na {len(wachttijden)} pogingen ({laatste}): {url}") from laatste
    if data[:2] == bytes([31, 139]):  # gzip-magic
        data = gzip.GzipFile(fileobj=io.BytesIO(data)).read()
    return data



def strip_html(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s or "")
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def parse_date(s: str) -> str:
    if not s:
        return ""
    try:
        dt = email.utils.parsedate_to_datetime(s)
    except Exception:
        try:
            dt = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:
            return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt.astimezone(datetime.timezone.utc).isoformat(timespec="seconds")


def text(el, *names):
    for n in names:
        found = el.find(n)
        if found is not None and (found.text or "").strip():
            return found.text.strip()
    return ""


NS = {"media": "http://search.yahoo.com/mrss/", "itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd"}
ITUNES_SUMMARY = "{http://www.itunes.com/dtds/podcast-1.0.dtd}summary"
DC_DATE = "{http://purl.org/dc/elements/1.1/}date"
CONTENT_ENCODED = "{http://purl.org/rss/1.0/modules/content/}encoded"

RUIS = re.compile(r"^(?:(?:AFP|ANP|Reuters)\s+)?NOS (?:Nieuws|Sport)\s*•|Zie meer zoekresultaten|^beeld:|^Foto:|Wilt u via de|Lees ook:|^Lees meer", re.I)


def _paras_uit_html(h, min_len=30):
    h = re.sub(r"<(script|style|noscript|svg|nav|header|footer|aside|form)[^>]*>.*?</\1>", " ", h, flags=re.S | re.I)
    m = re.search(r"<article[^>]*>(.*?)</article>", h, re.S | re.I)
    body = m.group(1) if m else h
    out = []
    for p in re.findall(r"<p[^>]*>(.*?)</p>", body, re.S | re.I):
        t = strip_html(p)
        if len(t) >= min_len and not RUIS.search(t):
            out.append(t)
    return out


def parse_feed(bron, naam, url, rubriek, maxn):
    root = ET.fromstring(fetch(url))
    items = []
    for it in root.iter("item"):
        link = text(it, "link")
        title = strip_html(text(it, "title"))
        desc = strip_html(text(it, "description", ITUNES_SUMMARY))
        pub = parse_date(text(it, "pubDate", DC_DATE))
        img = ""
        m = it.find("media:content", NS)
        if m is None:
            m = it.find("media:thumbnail", NS)
        if m is not None:
            img = m.get("url", "")
        else:
            enc = it.find("enclosure")
            if enc is not None and (enc.get("type") or "").startswith("image"):
                img = enc.get("url", "")
        if not title or not link:
            continue
        cat = strip_html(text(it, "category"))
        body = []
        encoded = text(it, CONTENT_ENCODED)
        if encoded and bron == "nieuwsbrieven":
            body = _paras_uit_html("<article>" + encoded + "</article>", min_len=2)[:200]
        items.append({
            "id": hashlib.sha1(link.encode()).hexdigest()[:16], "source": bron, "sourceName": naam,
            "section": cat if (cat and rubriek == naam) else ("" if rubriek == naam else rubriek), "title": title, "summary": desc[:400], "url": link, "image": img,
            "published": pub,
            **({"body": body, "bodyStatus": "full"} if body else {}),
        })
        if len(items) >= maxn:
            break
    return items



# ---------- Volledige artikeltekst ----------
CACHE = UIT / "tekst_cache.json"
MAX_NIEUW_PER_RUN = 90
MAX_TEKST = 12000




def _bnr_elementen(ce):
    out = []
    for el in ce or []:
        if not isinstance(el, dict):
            continue
        soort = str(el.get("@c", ""))
        if soort.endswith("Paragraph") or soort.endswith("Heading"):
            t = strip_html(" ".join(str(i.get("value", "")) for i in el.get("items", []) if isinstance(i, dict)))
            if t:
                out.append(t)
    return out


def _bnr(h):
    """BNR: oude paginavorm (__NEXT_DATA__) of nieuwe (Next.js-stroom met self.__next_f)."""
    out = []
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', h, re.S)
    if m:
        art = json.loads(m.group(1)).get("props", {}).get("pageProps", {}).get("article", {}) or {}
        intro = strip_html(art.get("intro") or "")
        ce = art.get("contentElements")
        if isinstance(ce, str):
            try:
                ce = json.loads(ce)
            except Exception:
                ce = []
        out = ([intro] if intro else []) + _bnr_elementen(ce)
    else:
        delen = re.findall(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)</script>', h, re.S)
        rsc = ""
        for d in delen:
            try:
                rsc += json.loads('"' + d + '"')
            except Exception:
                pass
        mi = re.search(r'"contentElements":"\$([0-9a-f]+)"[^{}]*?"intro":"((?:[^"\\]|\\.)*)"', rsc)
        ref = re.search(r'"contentElements":"\$([0-9a-f]+)"', rsc)
        if mi:
            try:
                out.append(strip_html(json.loads('"' + mi.group(2) + '"')))
            except Exception:
                pass
        if ref:
            j = rsc.find("\n" + ref.group(1) + ":")
            if j >= 0:
                k = rsc.find("[", j)
                try:
                    ce, _ = json.JSONDecoder().raw_decode(rsc, k)
                    out += _bnr_elementen(ce)
                except Exception:
                    pass
    out = [x for x in out if x]
    return (out, "full") if len(out) >= 2 else (_paras_uit_html(h), "full")


def artikel_tekst(bron, url):
    """Geeft (alinea's, status). status: full | partial | none."""
    if bron == "nu":
        return [], "none"          # DPG-privacygate, geen tekst zonder browser
    h = fetch(url, (0, 4)).decode("utf-8", "ignore")
    time.sleep(0.5)  # rustig tempo richting de nieuwssites
    if bron == "bnr":
        paras, status = _bnr(h)
    else:
        paras = _paras_uit_html(h)
        status = "partial" if bron == "rd" else ("full" if len(paras) >= 4 else "partial")
    if not paras:
        return [], "none"
    tekst, uit = 0, []
    for p in paras:
        if tekst + len(p) > MAX_TEKST:
            break
        uit.append(p); tekst += len(p)
    return uit, status


def vul_teksten(per_bron):
    cache = {}
    if CACHE.exists():
        try:
            cache = json.loads(CACHE.read_text(encoding="utf-8"))
        except Exception:
            cache = {}
    nu_ts = time.time()
    cache = {k: v for k, v in cache.items() if nu_ts - v.get("ts", 0) < 4 * 86400}
    nieuw = 0
    # Eerst de bronnen met volledige tekst, dan het RD (alleen openbaar deel).
    volgorde = sorted(per_bron.items(), key=lambda kv: {"nos": 0, "bnr": 0, "dagaandag": 1, "nd": 2, "rd": 3}.get(kv[0], 3))
    for bron, d in volgorde:
        for item in d.values():
            if item.get("body"):
                continue
            c = cache.get(item["id"])
            if c is None and nieuw < MAX_NIEUW_PER_RUN and bron != "nu":
                try:
                    body, status = artikel_tekst(bron, item["url"])
                except Exception:
                    body, status = [], "none"
                c = {"body": body, "bodyStatus": status, "ts": nu_ts}
                if body or bron == "nu":
                    cache[item["id"]] = c   # mislukte ophaalpoging niet onthouden, volgende keer opnieuw
                nieuw += 1
            if c:
                item["body"] = c["body"]; item["bodyStatus"] = c["bodyStatus"]
            else:
                item["body"] = []; item["bodyStatus"] = "none"
    CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    return nieuw


def main():
    UIT.mkdir(exist_ok=True)
    nu = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    per_bron, fouten = {}, []
    for bron, naam, url, rubriek, maxn in FEEDS:
        try:
            for item in parse_feed(bron, naam, url, rubriek, maxn):
                per_bron.setdefault(bron, {})
                per_bron[bron].setdefault(item["id"], item)
        except Exception as e:
            fouten.append({"bron": bron, "url": url, "fout": str(e)[:200]})

    nieuw = vul_teksten(per_bron)
    telling = {}
    for bron, d in per_bron.items():
        items = list(d.values())
        items.sort(key=lambda x: x["published"], reverse=True)
        doc = {"source": bron, "sourceName": BRONNAMEN.get(bron, bron), "updatedAt": nu, "items": items}
        (UIT / f"feeds_{bron}.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        telling[bron] = len(items)
    (UIT / "status.json").write_text(json.dumps({"updatedAt": nu, "counts": telling, "errors": fouten},
                                                ensure_ascii=False, indent=1), encoding="utf-8")
    print("klaar", nu, telling, "| teksten opgehaald:", nieuw)
    for f in fouten:
        print("FOUT", f["bron"], f["fout"])


if __name__ == "__main__":
    main()
