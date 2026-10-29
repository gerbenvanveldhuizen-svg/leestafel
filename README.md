# De Leestafel

Gerbens eigen krant als web-app voor telefoon, tablet en Boox. Nieuws uit het Reformatorisch Dagblad, Nederlands Dagblad, Dag aan Dag, NOS, NU.nl en de Substack van Cowork Operator. Werkt offline zodra de app één keer geopend is.

## Hoe het werkt

1. **GitHub ververst.** De taak in `.github/workflows/ververs.yml` draait drie keer per dag (rond 06:30, 12:30 en 17:30). Hij draait `bouw.py`, dat de feeds en artikelteksten ophaalt via `haal_feeds.py`.
2. **Versleuteld.** `bouw.py` versleutelt de editie (AES-256-GCM, sleutel afgeleid van een wachtwoord van vijf woorden) en schrijft `site/data/nieuws.json`. De site is openbaar, de artikelen niet: zonder wachtwoord is het bestand onleesbaar.
3. **De app** (`site/`) ontsleutelt op het apparaat zelf, bewaart de laatste editie voor offline lezen, en onthoudt per apparaat wat je gelezen, aangestreept of weggeklikt hebt.

## Een apparaat koppelen

Open de geheime link (staat in `geheim/link.txt`, nooit op GitHub) één keer op het apparaat. Daarna "Toevoegen aan startscherm" in Chrome. Zonder link kun je ook het wachtwoord typen.

## Wat de app per bron laat lezen

| Bron | In de app |
|---|---|
| Reformatorisch Dagblad | Openbare deel; de rest via "Open bij RD" met je eigen abonnement |
| Nederlands Dagblad | Openbare deel; de rest via "Open bij ND" |
| Dag aan Dag | Volledig of het openbare deel |
| NOS | Volledige tekst |
| NU.nl | Alleen de intro |
| Substack (Cowork Operator) | Volledige tekst uit de feed |

BNR zit er niet in: BNR weigert verzoeken van GitHub-servers (foutcode 403, botcontrole). Dat wordt niet omzeild.

## Beheer

- **Nu verversen:** op GitHub onder Actions, "Leestafel verversen", knop "Run workflow".
- **Bron toevoegen:** een regel in `FEEDS` in `haal_feeds.py`, en zo nodig een tabblad in `SOURCES` in `site/app.js`.
- **Wachtwoord wijzigen:** nieuw wachtwoord in `geheim/sleutel.txt` en in het GitHub-geheim `LEESTAFEL_SLEUTEL`; daarna elk apparaat opnieuw koppelen.
- **App aangepast?** Verhoog `VERSIE` in `site/sw.js`, anders blijven apparaten de oude versie tonen.
- GitHub zet geplande taken stil na 60 dagen zonder activiteit. De taak maakt daarom elke eerste van de maand een lege commit.

Lokaal testen: `python bouw.py` (gebruikt `geheim/sleutel.txt`), dan `python -m http.server` in `site/`.
