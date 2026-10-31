/* Tsundoku standalone platform layer: Supabase storage + auth, cover uploads, free metadata sources. */
(function(){
const CFG = window.TSUNDOKU_CONFIG || {};
const ready = !!(CFG.url && CFG.key && window.supabase);
const sb = ready ? window.supabase.createClient(CFG.url, CFG.key, {auth: {persistSession: true, autoRefreshToken: true}}) : null;

/* ---------- auth ---------- */
async function session(){ if (!sb) return null; const {data} = await sb.auth.getSession(); return data.session; }
function loginUI(){
  return new Promise(resolve => {
    const box = document.getElementById("login");
    box.hidden = false;
    const form = document.getElementById("loginForm"), msg = document.getElementById("loginMsg");
    let mode = "in";
    document.getElementById("loginSwitch").onclick = () => {
      mode = mode === "in" ? "up" : "in";
      document.getElementById("loginGo").textContent = mode === "in" ? "כניסה" : "יצירת חשבון";
      document.getElementById("loginSwitch").textContent = mode === "in" ? "אין לי עדיין חשבון" : "יש לי כבר חשבון";
      msg.textContent = "";
    };
    form.onsubmit = async e => {
      e.preventDefault();
      const email = document.getElementById("loginEmail").value.trim(), password = document.getElementById("loginPass").value;
      msg.textContent = "רגע…";
      const r = mode === "in" ? await sb.auth.signInWithPassword({email, password}) : await sb.auth.signUp({email, password, options: {emailRedirectTo: location.origin + location.pathname}});
      if (r.error){ msg.textContent = r.error.message === "Invalid login credentials" ? "אימייל או סיסמה לא נכונים." : r.error.message; return; }
      if (!r.data.session){ msg.textContent = "שלחנו לך מייל אישור. אחרי שתאשר, חזור לכאן ותיכנס."; mode = "up"; document.getElementById("loginSwitch").click(); return; }
      box.hidden = true; resolve(r.data.session);
    };
  });
}
async function signOut(){ if (sb) await sb.auth.signOut(); location.reload(); }

/* ---------- storage ---------- */
async function fetchAll(table, cols){
  let out = [], from = 0;
  for (;;){
    const {data, error} = await sb.from(table).select(cols).range(from, from + 999);
    if (error) throw error;
    out = out.concat(data); if (data.length < 1000) break; from += 1000;
  }
  return out;
}
const newId = () => "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function cloudStore(userId, toast){
  let rows = new Map(), cb = () => {};
  const emit = () => cb([...rows.values()]);
  const chains = {};
  const serial = (id, fn) => (chains[id] = (chains[id] || Promise.resolve()).then(fn, fn));
  return {
    async start(f){
      cb = f;
      const data = await fetchAll("items", "id,data");
      rows = new Map(data.map(r => [r.id, {id: r.id, ...r.data}])); emit();
      sb.channel("items-" + userId).on("postgres_changes", {event: "*", schema: "public", table: "items", filter: `user_id=eq.${userId}`}, p => {
        if (p.eventType === "DELETE") rows.delete(p.old.id);
        else rows.set(p.new.id, {id: p.new.id, ...p.new.data});
        emit();
      }).subscribe();
      document.addEventListener("visibilitychange", async () => {
        if (document.visibilityState !== "visible") return;
        try { const d = await fetchAll("items", "id,data"); rows = new Map(d.map(r => [r.id, {id: r.id, ...r.data}])); emit(); } catch {}
      });
    },
    async add(d){
      const id = newId(); rows.set(id, {id, ...d}); emit();
      const {error} = await sb.from("items").insert({id, user_id: userId, data: d});
      if (error){ rows.delete(id); emit(); throw error; }
    },
    patch: (id, p) => serial(id, async () => {
      const cur = rows.get(id); if (!cur) return;
      const {id: _, ...data} = {...cur, ...p};
      rows.set(id, {id, ...data}); emit();
      const {error} = await sb.from("items").update({data, updated_at: new Date().toISOString()}).eq("id", id);
      if (error) throw error;
    }),
    remove: id => serial(id, async () => {
      rows.delete(id); emit();
      const {error} = await sb.from("items").delete().eq("id", id);
      if (error) throw error;
    })
  };
}
async function getMeta(key){
  if (!sb) return null;
  const {data} = await sb.from("meta").select("data").eq("key", key).maybeSingle();
  return data ? data.data : null;
}

/* ---------- covers: Supabase Storage bucket "covers" ---------- */
function coverStore(userId){
  return {
    async upload(blob){
      const path = `${userId}/${newId()}.jpg`;
      const {error} = await sb.storage.from("covers").upload(path, blob, {contentType: "image/jpeg", upsert: false});
      if (error) throw error;
      return {id: path, url: sb.storage.from("covers").getPublicUrl(path).data.publicUrl};
    },
    async delete(id){ if (id && id.includes("/")) await sb.storage.from("covers").remove([id]); }
  };
}

/* ---------- free metadata sources ---------- */
const years = (a, b, ongoing) => a ? (ongoing ? `${a}–` : b && b !== a ? `${a}–${b}` : `${a}`) : "";
const FORMAT_HE = {TV: "סדרת טלוויזיה", TV_SHORT: "סדרה קצרה", MOVIE: "סרט", SPECIAL: "ספיישל", OVA: "OVA", ONA: "ONA", MUSIC: "קליפ", MANGA: "מנגה", NOVEL: "לייט נובל", ONE_SHOT: "וואן-שוט"};
const MEDIA = `id idMal format status episodes volumes chapters title{romaji english native} startDate{year} endDate{year} coverImage{large}
  studios(isMain:true){nodes{name}} staff(perPage:4,sort:RELEVANCE){edges{role node{name{full}}}}`;
async function anilist(query, variables, signal){
  const r = await fetch("https://graphql.anilist.co", {method: "POST", headers: {"Content-Type": "application/json", Accept: "application/json"}, body: JSON.stringify({query, variables}), signal});
  if (r.status === 429) { const e = new Error("rate"); e.code = "rate_limited"; throw e; }
  const j = await r.json(); if (j.errors && !j.data) throw new Error(j.errors[0].message);
  return j.data;
}
function fromAniList(m, kind){
  const ongoing = m.status === "RELEASING" || m.status === "NOT_YET_RELEASED";
  const story = (m.staff?.edges || []).find(e => /story/i.test(e.role)) || (m.staff?.edges || [])[0];
  return {
    title: m.title.english || m.title.romaji, titleJa: m.title.native || "",
    years: years(m.startDate?.year, m.endDate?.year, ongoing),
    author: kind === "anime" ? (m.studios?.nodes?.[0]?.name || "") : (story?.node?.name?.full || ""),
    total: kind === "anime" ? m.episodes ?? null : m.volumes ?? null,
    pubStatus: ongoing ? "ongoing" : "finished",
    note: [FORMAT_HE[m.format] || m.format, m.title.english && m.title.romaji !== m.title.english ? m.title.romaji : ""].filter(Boolean).join(" · "),
    cover: m.coverImage?.large || "", malId: m.idMal || null
  };
}
const SEARCH = {
  async anime(q, page, signal){
    const d = await anilist(`query($s:String,$p:Int){Page(page:$p,perPage:20){media(search:$s,type:ANIME,sort:SEARCH_MATCH){${MEDIA}}}}`, {s: q, p: page}, signal);
    return d.Page.media.map(m => fromAniList(m, "anime"));
  },
  async manga(q, page, signal){
    const d = await anilist(`query($s:String,$p:Int){Page(page:$p,perPage:20){media(search:$s,type:MANGA,sort:SEARCH_MATCH){${MEDIA}}}}`, {s: q, p: page}, signal);
    return d.Page.media.map(m => fromAniList(m, "manga"));
  },
  async books(q, page, signal){
    const he = /[֐-׿]/.test(q);
    const gb = async () => {
      const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=20&startIndex=${(page - 1) * 20}${he ? "&langRestrict=he" : ""}`, {signal});
      const j = await r.json();
      return (j.items || []).map(v => { const i = v.volumeInfo || {}; const t = [i.title, i.subtitle].filter(Boolean).join(": ");
        return {titleEn: he ? "" : t, titleHe: he ? t : "", title: t, author: (i.authors || []).join(", "), years: (i.publishedDate || "").slice(0, 4), books: 1, chapters: null,
          note: i.publisher || "", cover: (i.imageLinks?.thumbnail || "").replace("http://", "https://")}; });
    };
    if (he) return gb();
    try {
      const r = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=20&page=${page}&fields=title,author_name,first_publish_year,cover_i,number_of_pages_median`, {signal});
      const j = await r.json();
      const out = (j.docs || []).map(d => ({titleEn: d.title, titleHe: "", title: d.title, author: (d.author_name || []).slice(0, 2).join(", "), years: d.first_publish_year ? String(d.first_publish_year) : "",
        books: 1, chapters: null, note: d.number_of_pages_median ? `${d.number_of_pages_median} עמודים` : "", cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : ""}));
      return out.length ? out : gb();
    } catch (e) { if (e.name === "AbortError") throw e; return gb(); }
  },
  async comics(q, page, signal){
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q + " subject:comics")}&maxResults=20&startIndex=${(page - 1) * 20}`, {signal});
    const j = await r.json();
    return (j.items || []).map(v => { const i = v.volumeInfo || {};
      return {title: [i.title, i.subtitle].filter(Boolean).join(": "), author: (i.authors || []).join(", "), publisher: i.publisher || "", years: (i.publishedDate || "").slice(0, 4),
        unit: "volumes", total: null, note: i.seriesInfo ? "חלק מסדרה" : "", cover: (i.imageLinks?.thumbnail || "").replace("http://", "https://")}; });
  },
  async games(q, page, signal){
    if (page > 1) return [];
    const r = await fetch(`https://www.cheapshark.com/api/1.0/games?title=${encodeURIComponent(q)}&limit=20`, {signal});
    const j = await r.json();
    return (j || []).map(g => ({title: g.external, author: "", years: "", total: null,
      note: g.steamAppID ? "Steam" : "", steamId: g.steamAppID ? +g.steamAppID : null,
      cover: g.steamAppID ? `https://cdn.akamai.steamstatic.com/steam/apps/${g.steamAppID}/library_600x900.jpg` : (g.thumb || "")}));
  }
};

/* recommendations from AniList, seeded by the user's favourites */
async function recommend(kind, list, signal){
  if (kind !== "anime" && kind !== "manga") return null;
  const W = x => (x.status === "dropped" ? 5 : 0) + (x.score || 0) + (x.status === "completed" || x.status === "paused" ? 2 : 0);
  const seeds = list.filter(x => x.malId && x.status !== "planned").sort((a, b) => W(b) - W(a)).slice(0, 8);
  if (!seeds.length) return [];
  const T = kind === "anime" ? "ANIME" : "MANGA";
  const q = `query{${seeds.map((s, i) => `s${i}:Media(idMal:${s.malId},type:${T}){recommendations(sort:RATING_DESC,perPage:6){nodes{rating mediaRecommendation{${MEDIA}}}}}`).join(" ")}}`;
  const d = await anilist(q, {}, signal);
  const have = new Set(list.map(x => x.malId).filter(Boolean)), names = new Set(list.map(x => String(x.title).toLowerCase()));
  const pool = new Map();
  seeds.forEach((s, i) => (d[`s${i}`]?.recommendations?.nodes || []).forEach(n => {
    const m = n.mediaRecommendation; if (!m || have.has(m.idMal)) return;
    const r = fromAniList(m, kind); if (names.has(String(r.title).toLowerCase())) return;
    const k = m.id, cur = pool.get(k) || {...r, score: 0, from: []};
    cur.score += (n.rating || 0) + W(s); if (!cur.from.includes(s.title)) cur.from.push(s.title); pool.set(k, cur);
  }));
  return [...pool.values()].sort((a, b) => b.score - a.score).slice(0, 10)
    .map(r => ({...r, why: `כי ${kind === "anime" ? "ראית" : "קראת"} ${r.from.slice(0, 2).join(" ו-")}`}));
}

window.TS = {ready, sb, session, loginUI, signOut, cloudStore, coverStore, getMeta, SEARCH, recommend};
})();

/* one-time import of the data moved over from the Claude version */
window.TS.importSeed = async function(userId, onProgress){
  const sb = window.TS.sb;
  const r = await fetch("seed.json", {cache: "no-store"}); if (!r.ok) return false;
  const seed = await r.json();
  const rows = seed.items.map(x => ({id: x.id, user_id: userId, data: x.data}));
  for (let i = 0; i < rows.length; i += 400){
    const {error} = await sb.from("items").upsert(rows.slice(i, i + 400)); if (error) throw error;
    onProgress && onProgress(Math.min(rows.length, i + 400), rows.length);
  }
  const metas = Object.entries(seed.meta || {}).map(([key, data]) => ({user_id: userId, key, data}));
  if (metas.length){ const {error} = await sb.from("meta").upsert(metas); if (error) throw error; }
  return true;
};
