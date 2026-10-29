/* De Leestafel — zelfstandige leesapp. Data komt versleuteld binnen en wordt op het apparaat ontsleuteld. */
(() => {
  "use strict";

  const ZOUT = new TextEncoder().encode("de-leestafel-gerben-2026");
  const DATA_URL = "data/nieuws.json";
  const TZ = "Europe/Amsterdam";

  const SOURCES = [
    { id: "alles",         label: "Alles",         color: null },
    { id: "voorjou",       label: "Voor jou",      color: null },
    { id: "rd",            label: "RD",            color: "var(--c-rd)" },
    { id: "nd",            label: "ND",            color: "var(--c-nd)" },
    { id: "dagaandag",     label: "Dag aan Dag",   color: "var(--c-dad)" },
    { id: "nos",           label: "NOS",           color: "var(--c-nos)" },
    { id: "nu",            label: "NU.nl",         color: "var(--c-nu)" },
    { id: "nieuwsbrieven", label: "Nieuwsbrieven", color: "var(--c-nb)" },
    { id: "bewaard",       label: "Aangestreept",  color: null },
  ];
  const COLOR = Object.fromEntries(SOURCES.filter(s => s.color).map(s => [s.id, s.color]));

  // ---------- opslag op dit apparaat ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  let read = store.get("lt_read", {});
  let marks = store.get("lt_marks", {});
  let dismissed = store.get("lt_dismissed", {});
  let tab = store.get("lt_tab", "alles");
  let hideRead = store.get("lt_hideread", false);
  let fontScale = store.get("lt_font", 1);
  let noImg = store.get("lt_noimg", false);
  let eink = store.get("lt_eink", null);
  if (eink === null) eink = /onyx|boox|eink|e-ink/i.test(navigator.userAgent);

  const cutoff = Date.now() - 21 * 864e5;
  for (const [id, ts] of Object.entries(read)) if (ts < cutoff) delete read[id];
  for (const [id, v] of Object.entries(dismissed)) if ((v.dismissedAt || 0) < cutoff) delete dismissed[id];
  store.set("lt_read", read); store.set("lt_dismissed", dismissed);

  let items = [];
  let editie = null;
  let fromCache = false;
  let readerId = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => /^https?:\/\//i.test(u || "") ? u : "#";

  const fmtTime = new Intl.DateTimeFormat("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
  const fmtDay = new Intl.DateTimeFormat("nl-NL", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
  const fmtShort = new Intl.DateTimeFormat("nl-NL", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
  const dayKey = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  function dayLabel(d) {
    const k = dayKey(d);
    if (k === dayKey(new Date())) return "Vandaag";
    if (k === dayKey(new Date(Date.now() - 864e5))) return "Gisteren";
    return fmtDay.format(d);
  }

  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------- weergave-instellingen ----------
  function applyLook() {
    document.documentElement.classList.toggle("eink", !!eink);
    document.documentElement.classList.toggle("noimg", !!noImg);
    document.documentElement.style.setProperty("--fs-read", `calc(${eink ? 21 : 19}px * ${fontScale})`);
    $("einkBtn").setAttribute("aria-pressed", String(!!eink));
    $("hideRead").setAttribute("aria-pressed", String(!!hideRead));
    $("imgBtn").textContent = noImg ? "Afbeeldingen aan" : "Afbeeldingen uit";
  }
  $("einkBtn").addEventListener("click", () => { eink = !eink; store.set("lt_eink", eink); applyLook(); render(); });
  $("hideRead").addEventListener("click", () => { hideRead = !hideRead; store.set("lt_hideread", hideRead); applyLook(); render(); });
  $("imgBtn").addEventListener("click", () => { noImg = !noImg; store.set("lt_noimg", noImg); applyLook(); render(); });
  $("today").textContent = fmtDay.format(new Date());

  // ---------- sleutel en ontsleutelen ----------
  const b64d = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const b64e = (u8) => btoa(String.fromCharCode(...u8));

  async function deriveKey(pw, iter) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw.trim()), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: ZOUT, iterations: iter, hash: "SHA-256" }, base, 256);
    return new Uint8Array(bits);
  }
  async function decrypt(pakket, raw) {
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(pakket.iv) }, key, b64d(pakket.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  function storedKey(iter) {
    const k = store.get("lt_key", null);
    return k && k.iter === iter ? b64d(k.raw) : null;
  }

  async function fetchPakket() {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("status " + res.status);
    fromCache = res.headers.get("X-Leestafel-Cache") === "1";
    return res.json();
  }

  async function load(pwFromUser) {
    let pakket;
    try { pakket = await fetchPakket(); }
    catch (e) {
      $("updated").textContent = "nog geen editie op dit apparaat";
      if (!items.length) showEmpty("Geen verbinding", "Zet wifi aan en open de app één keer, daarna lees je ook offline.");
      return;
    }
    let raw = storedKey(pakket.iter);
    if (pwFromUser) raw = await deriveKey(pwFromUser, pakket.iter);
    if (!raw) { showGate(); return; }
    try {
      editie = await decrypt(pakket, raw);
    } catch (e) {
      store.del("lt_key");
      showGate(pwFromUser ? "Dit wachtwoord klopt niet. Let op de streepjes tussen de woorden." : "");
      return;
    }
    store.set("lt_key", { iter: pakket.iter, raw: b64e(raw) });
    $("gate").hidden = true;
    items = editie.items || [];
    paintUpdated();
    render();
  }

  function paintUpdated() {
    if (!editie?.updatedAt) return;
    const d = new Date(editie.updatedAt);
    const k = dayKey(d) === dayKey(new Date()) ? "" : fmtShort.format(d) + " ";
    $("updated").innerHTML = `editie ${esc(k)}${esc(fmtTime.format(d))}${fromCache || !navigator.onLine ? '<span class="off">offline</span>' : ""}`;
    const NAMEN = { rd: "RD", nd: "ND", nos: "NOS", nu: "NU.nl", dagaandag: "Dag aan Dag", nieuwsbrieven: "nieuwsbrieven" };
    const mis = [...new Set((editie.errors || []).map(e => NAMEN[e.bron] || e.bron))];
    $("updated").title = mis.length ? `Niet bijgewerkt deze keer: ${mis.join(", ")}` : "";
    if (mis.length) $("updated").innerHTML += `<br><span style="font-size:11.5px">${esc(mis.join(", "))}: vorige editie</span>`;
  }

  function showGate(err) {
    $("gate").hidden = false;
    $("list").innerHTML = ""; $("empty").hidden = true; $("lead").hidden = true; $("toolbar").hidden = true;
    $("gateErr").hidden = !err; $("gateErr").textContent = err || "";
    $("updated").textContent = "vergrendeld";
  }
  $("gateForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = $("gatePw").value;
    if (!pw.trim()) return;
    $("gateErr").hidden = true;
    await load(pw);
  });
  $("lockBtn").addEventListener("click", () => { store.del("lt_key"); items = []; editie = null; showGate(); });
  $("refreshBtn").addEventListener("click", async () => {
    $("updated").textContent = "vernieuwen…";
    await load();
    toast(fromCache ? "Geen verbinding, je leest de bewaarde editie" : "Bijgewerkt");
  });

  // ---------- leren wat je leuk vindt ----------
  const STOP = new Set("de het een van in op en voor met naar bij aan om is zijn dat die dit niet ook als er na uit over door wordt worden meer tegen onder tussen volgens nieuwe nieuw jaar the and for with from this that how why what you your hoe wat waarom kan moet wie wel nog weer zich hun haar hij zij".split(" "));
  const words = (s) => (s || "").toLowerCase().replace(/[^a-zà-ÿ0-9\s-]/g, " ").split(/\s+/).filter(w => w.length >= 4 && !STOP.has(w));
  function buildProfile() {
    const prof = { n: 0, src: {}, sec: {}, word: {} };
    const bump = (m, k, v) => { if (k) m[k] = (m[k] || 0) + v; };
    for (const [list, v] of [[Object.values(marks), 1], [Object.values(dismissed), -1]]) {
      for (const it of list) {
        prof.n++; bump(prof.src, it.source, v); bump(prof.sec, it.section, v);
        for (const w of new Set(words(it.title))) bump(prof.word, w, v);
      }
    }
    return prof;
  }
  function score(it, prof) {
    let s = 0; const why = [];
    const sw = prof.src[it.source] || 0; if (sw) s += Math.max(-2, Math.min(2, sw * 0.5));
    const cw = prof.sec[it.section] || 0; if (cw) { s += Math.max(-2, Math.min(2, cw * 0.7)); if (cw > 0) why.push(it.section); }
    let hits = 0, miss = 0;
    for (const w of new Set(words(it.title + " " + (it.summary || "").slice(0, 160)))) {
      const v = prof.word[w] || 0;
      if (v > 0 && hits < 3) { hits++; s += 1.2; why.push(w); }
      else if (v < 0 && miss < 3) { miss++; s -= 1; }
    }
    const age = it.published ? (Date.now() - new Date(it.published)) / 864e5 : 3;
    s -= Math.min(3, age) * 0.6;
    return { s, why: why.slice(0, 3) };
  }

  // ---------- lijst ----------
  const visible = () => items.filter(it => !dismissed[it.id]);
  const findItem = (id) => items.find(x => x.id === id) || marks[id] || null;

  function countPerSource() {
    const c = {};
    for (const it of visible()) { if (hideRead && read[it.id]) continue; c[it.source] = (c[it.source] || 0) + 1; }
    c.bewaard = Object.keys(marks).length;
    return c;
  }
  function renderTabs() {
    const counts = countPerSource();
    $("tabs").innerHTML = SOURCES.map(s => `
      <button class="tab" role="tab" type="button" data-tab="${s.id}" aria-selected="${tab === s.id}" ${s.color ? `style="--dotc:${s.color}"` : ""}>
        ${s.color ? '<span class="dot"></span>' : ""}${s.label}${counts[s.id] ? `<span class="n">${counts[s.id]}</span>` : ""}
      </button>`).join("");
  }
  $("tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".tab"); if (!b) return;
    tab = b.dataset.tab; store.set("lt_tab", tab); render(); window.scrollTo({ top: 0 });
  });

  function itemsForTab() {
    if (tab === "bewaard") return Object.values(marks).sort((a, b) => (b.markedAt || 0) - (a.markedAt || 0));
    let list = visible();
    if (tab === "voorjou") {
      const prof = buildProfile();
      if (prof.n < 3) return [];
      return list.filter(it => !read[it.id] && !marks[it.id])
        .map(it => { const r = score(it, prof); return { ...it, _score: r.s, _why: r.why }; })
        .filter(it => it._score > 0.5).sort((a, b) => b._score - a._score).slice(0, 25);
    }
    if (tab !== "alles") list = list.filter(it => it.source === tab);
    if (hideRead) list = list.filter(it => !read[it.id]);
    return list.sort((a, b) => (b.published || "").localeCompare(a.published || ""));
  }

  function renderLead() {
    const lead = $("lead"); lead.hidden = true;
    if (tab !== "alles" || !items.length) return;
    const med = items.find(it => it.source === "rd" && it.section === "Meditatie" && !read[it.id]);
    const verd = items.find(it => it.source === "dagaandag" && /verdieping|preekverslag|levensverhaal/i.test(it.section || "") && !read[it.id] && !dismissed[it.id]);
    const pick = med ? { ...med, kicker: "Meditatie · Reformatorisch Dagblad", color: COLOR.rd }
             : verd ? { ...verd, kicker: `${verd.section} · Dag aan Dag`, color: COLOR.dagaandag } : null;
    if (!pick) return;
    lead.hidden = false; lead.dataset.id = pick.id; lead.href = safeUrl(pick.url);
    lead.style.setProperty("--leadc", pick.color);
    $("leadKicker").textContent = pick.kicker; $("leadTitle").textContent = pick.title; $("leadText").textContent = pick.summary || "";
  }

  const I = {
    mark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"/><path d="M14 7l3 3"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/></svg>',
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  };

  function renderItem(it) {
    const d = it.published ? new Date(it.published) : null;
    const isMarked = !!marks[it.id];
    const cls = ["item", read[it.id] ? "read" : "", isMarked ? "marked" : ""].join(" ");
    const when = d ? `<time datetime="${esc(it.published)}">${tab === "alles" ? fmtTime.format(d) : fmtShort.format(d) + " " + fmtTime.format(d)}</time>` : "";
    const hasBody = Array.isArray(it.body) && it.body.length;
    const img = it.image && !eink && !noImg ? `<img class="thumb" src="${esc(safeUrl(it.image))}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "";
    return `
      <article class="${cls}" data-id="${esc(it.id)}" style="--srcc:${COLOR[it.source] || "var(--muted)"}">
        <div class="main">
          <div class="meta"><span class="src">${esc(it.sourceName || it.source)}</span>${it.section ? `<span class="sec">${esc(it.section)}</span>` : ""}${when}</div>
          <h3><a href="${esc(safeUrl(it.url))}" class="open-reader">${esc(it.title)}</a></h3>
          ${it.summary ? `<p>${esc(it.summary)}</p>` : ""}
          ${it._why?.length ? `<div class="why">Omdat je vaker kiest voor: ${esc(it._why.join(", "))}</div>` : ""}
          ${hasBody ? "" : `<div class="full">Alleen intro, volledig stuk bij de bron</div>`}
        </div>
        ${img}
        <div class="actions">
          <button class="act mark" type="button" aria-pressed="${isMarked}">${I.mark}${isMarked ? "Aangestreept" : "Aanstrepen"}</button>
          <button class="act share" type="button">${I.share}Delen</button>
          ${tab === "bewaard" ? "" : `<button class="act away" type="button">${I.x}Weg</button>`}
        </div>
      </article>`;
  }

  function showEmpty(title, text) {
    $("empty").hidden = false; $("emptyTitle").textContent = title; $("emptyText").textContent = text;
  }

  function render() {
    if (!editie) return;
    $("toolbar").hidden = false;
    renderTabs(); renderLead();
    if (readerId) renderReader(readerId, true);
    const list = itemsForTab();
    $("empty").hidden = true;
    if (!list.length) {
      $("list").innerHTML = ""; $("count").textContent = "";
      if (tab === "bewaard") showEmpty("Nog niets aangestreept", "Tik op 'Aanstrepen' bij een bericht om het hier te bewaren.");
      else if (tab === "voorjou") {
        const n = Object.keys(marks).length + Object.keys(dismissed).length;
        showEmpty(n < 3 ? "Dit tabblad leert nog" : "Niets nieuws dat bij je past",
          n < 3 ? "Streep berichten aan en klik weg wat je niet wilt. Na drie keuzes verschijnt hier een selectie op maat."
                : "Alles wat op je keuzes lijkt heb je al gelezen. Bij de volgende editie kijk ik opnieuw.");
      } else showEmpty(hideRead ? "Alles gelezen" : "Niets in deze bron", hideRead ? "Zet 'Gelezen verbergen' uit om alles terug te zien." : "Bij de volgende editie komt hier nieuws binnen.");
      return;
    }
    $("count").textContent = `${list.length} bericht${list.length === 1 ? "" : "en"}`;
    if (tab === "bewaard" || tab === "voorjou") {
      const n = Object.keys(marks).length + Object.keys(dismissed).length;
      const hint = tab === "voorjou" && n < 10 ? `<p class="why" style="margin:14px 0 0">Gebaseerd op ${n} keuze${n === 1 ? "" : "s"}. Hoe meer je aanstreept en wegklikt, hoe beter.</p>` : "";
      $("list").innerHTML = `${hint}<div class="list" style="margin-top:14px">${list.map(renderItem).join("")}</div>`;
      return;
    }
    const groups = [];
    for (const it of list) {
      const label = it.published ? dayLabel(new Date(it.published)) : "Zonder datum";
      const g = groups[groups.length - 1];
      if (g && g.label === label) g.items.push(it); else groups.push({ label, items: [it] });
    }
    $("list").innerHTML = groups.map(g => `<h2 class="day">${esc(g.label)}</h2><div class="list">${g.items.map(renderItem).join("")}</div>`).join("");
  }

  // ---------- acties ----------
  function markRead(id) {
    if (!id || read[id]) return;
    read[id] = Date.now(); store.set("lt_read", read);
    document.querySelectorAll(`.item[data-id="${CSS.escape(id)}"]`).forEach(el => el.classList.add("read"));
  }
  function strip(it) { const { _score, _why, ...rest } = it; return rest; }
  function toggleMark(id) {
    const it = findItem(id); if (!it) return;
    if (marks[id]) delete marks[id]; else marks[id] = { ...strip(it), markedAt: Date.now() };
    store.set("lt_marks", marks); render();
  }
  function dismiss(id) {
    const it = findItem(id); if (!it) return;
    dismissed[id] = { id, title: it.title, source: it.source, section: it.section || "", dismissedAt: Date.now() };
    store.set("lt_dismissed", dismissed);
    if (readerId === id) closeReader(false);
    render(); toast("Weggeklikt");
  }
  async function share(id) {
    const it = findItem(id); if (!it) return;
    const data = { title: it.title, text: `${it.title}\n${it.summary || ""}`.trim(), url: safeUrl(it.url) };
    if (navigator.share) {
      try { await navigator.share(data); } catch (e) { if (e?.name !== "AbortError") toast("Delen lukte niet"); }
      return;
    }
    try { await navigator.clipboard.writeText(`${it.title}\n${it.url}`); toast("Link gekopieerd"); }
    catch { toast("Delen kan hier niet"); }
  }

  document.addEventListener("click", (e) => {
    const act = e.target.closest(".act");
    if (act) {
      e.preventDefault();
      const id = act.closest("[data-id]")?.dataset.id;
      if (act.classList.contains("mark")) toggleMark(id);
      else if (act.classList.contains("share")) share(id);
      else if (act.classList.contains("away")) dismiss(id);
      return;
    }
    const link = e.target.closest("a.open-reader");
    if (link) {
      e.preventDefault();
      const el = link.closest("[data-id]");
      if (el?.dataset.id) openReader(el.dataset.id);
    }
  });

  // ---------- leesvenster ----------
  function renderReader(id, keepScroll) {
    const it = findItem(id); const reader = $("reader");
    if (!it) { reader.hidden = true; return; }
    const prev = keepScroll ? reader.scrollTop : 0;
    const d = it.published ? new Date(it.published) : null;
    const body = Array.isArray(it.body) ? it.body.filter(p => p && p.trim()) : [];
    const status = it.bodyStatus || (body.length ? "full" : "none");
    const naam = it.sourceName || it.source;
    let note = "";
    if (status === "partial") note = `<div class="note">Dit is het openbare deel. De rest lees je als abonnee bij ${esc(naam)}.</div>`;
    else if (!body.length) note = `<div class="note">Van dit bericht is alleen de intro beschikbaar. Het hele stuk staat bij ${esc(naam)}.</div>`;
    const showIntro = it.summary && (!body.length || !body[0].startsWith(it.summary.slice(0, 40)));
    const isMarked = !!marks[it.id];
    reader.innerHTML = `
      <div class="bar">
        <button class="back" type="button" id="readerBack">${I.back}Terug</button>
        <div class="size"><button type="button" data-size="-1" aria-label="Kleinere letter">A−</button><button type="button" data-size="1" aria-label="Grotere letter">A+</button></div>
      </div>
      <article class="inner" data-id="${esc(it.id)}">
        <div class="kicker">${esc(naam)}${it.section ? " · " + esc(it.section) : ""}${d ? " · " + esc(fmtShort.format(d)) + " " + esc(fmtTime.format(d)) : ""}</div>
        <h1>${esc(it.title)}</h1>
        ${it.image ? `<img class="hero" src="${esc(safeUrl(it.image))}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
        ${showIntro ? `<p class="intro">${esc(it.summary)}</p>` : ""}
        <div class="body">${body.map(p => `<p>${esc(p)}</p>`).join("")}</div>
        ${note}
        <div class="ract">
          <a class="open" href="${esc(safeUrl(it.url))}" target="_blank" rel="noopener">Open bij ${esc(naam)}</a>
          <button class="act mark" type="button" aria-pressed="${isMarked}">${I.mark}${isMarked ? "Aangestreept" : "Aanstrepen"}</button>
          <button class="act share" type="button">${I.share}Delen</button>
          <button class="act away" type="button">${I.x}Weg</button>
        </div>
      </article>
      <div class="pager"><button type="button" data-page="-1">▲ Terug bladeren</button><button type="button" data-page="1">Verder ▼</button></div>`;
    reader.hidden = false; reader.scrollTop = prev;
    document.body.classList.add("noscroll");
  }
  function openReader(id) {
    if (!findItem(id)) return;
    const alOpen = !!readerId;
    readerId = id; markRead(id); renderReader(id);
    try { if (alOpen) history.replaceState({ reader: id }, ""); else history.pushState({ reader: id }, ""); } catch {}
  }
  function closeReader(viaHistory) {
    const was = readerId;
    readerId = null; $("reader").hidden = true; document.body.classList.remove("noscroll");
    if (!viaHistory) { try { if (history.state?.reader === was) history.back(); } catch {} }
  }
  // Terugknop: elke stap terug die niet bij het open artikel hoort, sluit het leesvenster.
  window.addEventListener("popstate", () => { if (readerId && history.state?.reader !== readerId) closeReader(true); });
  // Oude leesstand uit een vorige sessie opruimen, zodat "terug" altijd naar de lijst gaat.
  try { if (history.state?.reader) history.replaceState(null, ""); } catch {}
  $("reader").addEventListener("click", (e) => {
    if (e.target.closest("#readerBack")) { closeReader(false); return; }
    const sz = e.target.closest("[data-size]");
    if (sz) { fontScale = Math.min(1.6, Math.max(0.8, +(fontScale + 0.1 * +sz.dataset.size).toFixed(2))); store.set("lt_font", fontScale); applyLook(); return; }
    const pg = e.target.closest("[data-page]");
    if (pg) { const r = $("reader"); r.scrollTop += +pg.dataset.page * (r.clientHeight - 140); }
  });
  document.addEventListener("keydown", (e) => {
    if (!readerId) return;
    if (e.key === "Escape") closeReader(false);
    if (e.key === "PageDown" || e.key === "ArrowRight") { const r = $("reader"); r.scrollTop += r.clientHeight - 140; }
    if (e.key === "PageUp" || e.key === "ArrowLeft") { const r = $("reader"); r.scrollTop -= r.clientHeight - 140; }
  });

  // ---------- start ----------
  applyLook();
  window.addEventListener("online", () => load());
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  // Geheime link: #sleutel=woord-woord-woord-woord-woord, één keer per apparaat.
  function sleutelUitLink() {
    const m = location.hash.match(/sleutel=([^&]+)/);
    if (!m) return null;
    const pw = decodeURIComponent(m[1]);
    try { history.replaceState(null, "", location.pathname + location.search); } catch {}
    return pw;
  }
  window.addEventListener("hashchange", () => { const pw = sleutelUitLink(); if (pw) load(pw); });
  load(sleutelUitLink() || undefined);
})();
