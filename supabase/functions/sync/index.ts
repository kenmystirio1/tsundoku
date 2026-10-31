// Tsundoku "sync": runs every hour (pg_cron) and on demand from the app.
//  • MyAnimeList ⇄ Tsundoku for anime + manga (status, progress, score), three-way against the
//    state saved at the previous sync, so whichever side changed wins (newest wins if both did).
//  • Exophase → Tsundoku for games: hours played + achievements only. Never touches a game's
//    status or folder — those are the user's call in the app.
// Deploy with JWT verification OFF. Cron calls carry the x-cron secret; the app calls with the
// signed-in user's token and only that user is synced.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const MAL_CLIENT_ID = Deno.env.get("MAL_CLIENT_ID") || "";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

type Item = { id: string; data: Record<string, any> };
const ST_NUM: Record<number, string> = { 1: "reading", 2: "completed", 3: "paused", 4: "dropped", 6: "planned" };
const FROM_MAL: Record<string, string> = { watching: "reading", reading: "reading", completed: "completed", on_hold: "paused", dropped: "dropped", plan_to_watch: "planned", plan_to_read: "planned" };
const TO_MAL = { anime: { reading: "watching", completed: "completed", paused: "on_hold", dropped: "dropped", planned: "plan_to_watch" },
                 manga: { reading: "reading", completed: "completed", paused: "on_hold", dropped: "dropped", planned: "plan_to_read" } } as const;

/* ---------------- MyAnimeList ---------------- */
async function malToken(uid: string): Promise<string | null> {
  const { data: t } = await db.from("mal_tokens").select("*").eq("user_id", uid).maybeSingle();
  if (!t) return null;
  if (new Date(t.expires_at).getTime() > Date.now()) return t.access_token;
  const r = await fetch("https://myanimelist.net/v1/oauth2/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: MAL_CLIENT_ID, grant_type: "refresh_token", refresh_token: t.refresh_token }),
  });
  const n = await r.json();
  if (!r.ok || !n.access_token) return null;
  await db.from("mal_tokens").update({ access_token: n.access_token, refresh_token: n.refresh_token,
    expires_at: new Date(Date.now() + (n.expires_in - 300) * 1000).toISOString() }).eq("user_id", uid);
  return n.access_token;
}
async function malList(token: string, kind: "anime" | "manga") {
  const fields = kind === "anime"
    ? "list_status,num_episodes,status,main_picture,alternative_titles,start_date,end_date,studios"
    : "list_status,num_volumes,num_chapters,status,main_picture,alternative_titles,start_date,authors{first_name,last_name}";
  let url: string | null = `https://api.myanimelist.net/v2/users/@me/${kind}list?fields=${fields}&limit=1000&nsfw=true`;
  const out: any[] = [];
  while (url) {
    const r: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`MAL ${kind}list ${r.status}`);
    const j = await r.json();
    out.push(...(j.data || []));
    url = j.paging?.next || null;
  }
  return out;
}
const ms = (d?: string) => d ? new Date(d).getTime() : 0;

async function syncMal(uid: string, items: Item[], baseRaw: any, log: string[]) {
  const token = await malToken(uid);
  if (!token) return null;
  const base: Record<string, any> = {};
  // accept the old baseline format {A:{id:[st,ep,score]}, M:{id:[st,vol,ch,score]}} and the new {k:{...}}
  if (baseRaw?.A) for (const [id, v] of Object.entries<any>(baseRaw.A)) base[`a${id}`] = { status: typeof v[0] === "number" ? ST_NUM[v[0]] : v[0], p: v[1], score: v[2] };
  if (baseRaw?.M) for (const [id, v] of Object.entries<any>(baseRaw.M)) base[`m${id}`] = { status: typeof v[0] === "number" ? ST_NUM[v[0]] : v[0], p: v[1], ch: v[2], score: v[3] };
  if (baseRaw?.K) Object.assign(base, baseRaw.K);

  const byKey = new Map<string, Item>();
  for (const it of items) {
    const k = it.data.type === "anime" ? "a" : it.data.type === "manga" ? "m" : null;
    if (!k) continue;
    const mid = it.data.malId || (/^mal-[am](\d+)$/.exec(it.id)?.[1]);
    if (mid) byKey.set(`${k}${mid}`, it);
  }
  const lists = { a: await malList(token, "anime"), m: await malList(token, "manga") };
  const mal = new Map<string, any>();
  for (const k of ["a", "m"] as const) for (const e of lists[k]) mal.set(`${k}${e.node.id}`, e);

  const tPatch = new Map<string, Record<string, any>>(), creates: Item[] = [], malPush: { key: string; body: Record<string, string> }[] = [];
  const newBase: Record<string, any> = {};
  const P = (k: string) => k[0] === "a" ? "episodesWatched" : "volumesRead";

  for (const key of new Set([...mal.keys(), ...byKey.keys()])) {
    const kind = key[0] === "a" ? "anime" : "manga", id = +key.slice(1);
    const e = mal.get(key), it = byKey.get(key), b = base[key];
    const C = e && { status: FROM_MAL[e.list_status.status] || "planned", score: e.list_status.score || 0,
      p: kind === "anime" ? e.list_status.num_episodes_watched || 0 : e.list_status.num_volumes_read || 0,
      ...(kind === "manga" ? { ch: e.list_status.num_chapters_read || 0 } : {}) };
    const T = it && { status: it.data.status, score: it.data.score || 0, p: it.data[P(key)] || 0,
      ...(kind === "manga" ? { ch: it.data.chaptersRead || 0 } : {}) };

    if (C && !T) { // new on MAL → add to Tsundoku
      const n = e.node, ongoing = n.status === "currently_airing" || n.status === "currently_publishing";
      const d: Record<string, any> = {
        type: kind, title: n.alternative_titles?.en || n.title, titleJa: n.alternative_titles?.ja || "",
        author: kind === "anime" ? (n.studios?.[0]?.name || "") : (n.authors || []).map((a: any) => [a.node.first_name, a.node.last_name].filter(Boolean).join(" ")).slice(0, 2).join(", "),
        status: C.status, score: C.score, notes: "", pubStatus: ongoing ? "ongoing" : "finished",
        coverUrl: n.main_picture?.large || n.main_picture?.medium || "", malId: id, source: "mal",
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      if (kind === "anime") { d.episodesWatched = C.p; d.totalEpisodes = n.num_episodes || null; }
      else { d.volumesRead = C.p; d.chaptersRead = (C as any).ch; d.totalVolumes = n.num_volumes || null; }
      if (e.list_status.finish_date) d.finishedAt = ms(e.list_status.finish_date);
      creates.push({ id: `mal-${key}`, data: d });
      newBase[key] = C; log.push(`+ ${d.title} (מ-MAL)`);
      continue;
    }
    if (T && !C) {
      if (b) { newBase[key] = b; continue; }                 // removed on MAL since last time → leave it
      const body: Record<string, string> = { status: TO_MAL[kind][T.status as keyof typeof TO_MAL.anime] || TO_MAL[kind].planned, score: String(T.score) };
      if (kind === "anime") body.num_watched_episodes = String(T.p); else { body.num_volumes_read = String(T.p); body.num_chapters_read = String((T as any).ch); }
      malPush.push({ key, body }); newBase[key] = T; log.push(`→ MAL: ${it!.data.title} (חדש)`);
      continue;
    }
    // both sides have it: field-by-field three-way merge
    const merged: any = { ...T }, toT: Record<string, any> = {}, toM: Record<string, any> = {};
    const malNewer = ms(e.list_status.updated_at) > (it!.data.updatedAt || 0);
    for (const f of Object.keys(C) as (keyof typeof C)[]) {
      const c = (C as any)[f], t = (T as any)[f], bv = b ? b[f] : undefined;
      if (c === t) continue;
      const pull = bv === undefined ? malNewer : t === bv ? true : c === bv ? false : malNewer;
      if (pull) { merged[f] = c; toT[f] = c; } else { toM[f] = t; }
    }
    newBase[key] = merged;
    if (Object.keys(toT).length) {
      const patch: Record<string, any> = {};
      if ("status" in toT) patch.status = toT.status;
      if ("score" in toT) patch.score = toT.score;
      if ("p" in toT) patch[P(key)] = toT.p;
      if ("ch" in toT) patch.chaptersRead = toT.ch;
      if ((toT.status === "completed" || toT.status === "paused") && !it!.data.finishedAt)
        patch.finishedAt = ms(e.list_status.finish_date) || Date.now();
      tPatch.set(it!.id, patch); log.push(`← ${it!.data.title}: ${Object.keys(toT).join(", ")}`);
    }
    // keep totals fresh from MAL's catalogue
    const tot = kind === "anime" ? e.node.num_episodes : e.node.num_volumes, tf = kind === "anime" ? "totalEpisodes" : "totalVolumes";
    if (tot && tot !== it!.data[tf]) tPatch.set(it!.id, { ...(tPatch.get(it!.id) || {}), [tf]: tot });
    if (Object.keys(toM).length) {
      const body: Record<string, string> = {};
      if ("status" in toM) body.status = TO_MAL[kind][toM.status as keyof typeof TO_MAL.anime];
      if ("score" in toM) body.score = String(toM.score);
      if ("p" in toM) body[kind === "anime" ? "num_watched_episodes" : "num_volumes_read"] = String(toM.p);
      if ("ch" in toM) body.num_chapters_read = String(toM.ch);
      malPush.push({ key, body }); log.push(`→ MAL: ${it!.data.title}: ${Object.keys(toM).join(", ")}`);
    }
  }

  for (const { key, body } of malPush) {
    const kind = key[0] === "a" ? "anime" : "manga";
    const r = await fetch(`https://api.myanimelist.net/v2/${kind}/${key.slice(1)}/my_list_status`, {
      method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
    if (!r.ok) { log.push(`! MAL ${key} ${r.status}`); delete newBase[key]; if (base[key]) newBase[key] = base[key]; }
  }
  return { tPatch, creates, baseline: { K: newBase, syncedAt: new Date().toISOString() } };
}

/* ---------------- Exophase (games) ---------------- */
const hrs = (s: string) => { if (!s) return 0; const h = /(\d+)h/.exec(s), m = /(\d+)m/.exec(s); return Math.round(((h ? +h[1] : 0) + (m ? +m[1] : 0) / 60) * 10) / 10; };
const norm = (t: string) => String(t || "").toLowerCase().replace(/[™®©]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
async function exoGames(pid: number) {
  const out: any[] = [];
  for (let page = 1; page < 30; page++) {
    const r = await fetch(`https://api.exophase.com/public/player/${pid}/games?page=${page}&sort=1`, { headers: { "User-Agent": "Tsundoku personal tracker" } });
    if (!r.ok) break;
    const g = (await r.json()).games || [];
    out.push(...g); if (!g.length || g.length < 45) break;
  }
  return out;
}
async function syncExophase(items: Item[], ids: Record<string, number>, tPatch: Map<string, Record<string, any>>, creates: Item[], log: string[]) {
  const byId = new Map(items.map(i => [i.id, i]));
  const steamByTitle = new Map(items.filter(i => i.data.type === "games" && i.data.steamId).map(i => [norm(i.data.title), i]));
  const plats: [string, string, string][] = [["psn", "p", "PlayStation"], ["nintendo", "n", "Nintendo Switch"], ["steam", "", "Steam"]];
  for (const [key, pre, platform] of plats) {
    if (!ids?.[key]) continue;
    let games: any[] = [];
    try { games = await exoGames(ids[key]); } catch { log.push(`! Exophase ${key}`); continue; }
    for (const g of games) {
      const h = hrs(g.playtime), it = pre ? byId.get(`exo-${pre}${g.master_id}`) : steamByTitle.get(norm(g.meta?.title));
      if (it) {
        const patch: Record<string, any> = {};
        if (h > (it.data.hoursPlayed || 0)) patch.hoursPlayed = h;          // hours only ever go up
        if (g.total_awards && g.earned_awards !== it.data.achievements) { patch.achievements = g.earned_awards; patch.achPct = g.percent; }
        if (g.completion_date && it.data.status === "completed" && !it.data.finishedAt) patch.finishedAt = g.completion_date * 1000;
        if (Object.keys(patch).length) { tPatch.set(it.id, { ...(tPatch.get(it.id) || {}), ...patch }); if (patch.hoursPlayed) log.push(`⏱ ${it.data.title}: ${patch.hoursPlayed} ש׳`); }
      } else if (pre) { // a console game we haven't seen → backlog
        const cover = String(g.resource_standard || "").replace("/games/m/", "/games/o/");
        creates.push({ id: `exo-${pre}${g.master_id}`, data: {
          type: "games", title: g.meta?.title || "?", titleJa: "", author: "", status: "planned", prio: "backlog", score: 0, notes: "", pubStatus: "",
          platform, hoursPlayed: h, hoursToBeat: null, achievements: g.earned_awards || 0, achPct: g.percent || 0, exoId: g.master_id,
          coverUrl: cover, source: "exophase", createdAt: Date.now(), updatedAt: Date.now() } });
        log.push(`+ ${g.meta?.title} (${platform})`);
      }
    }
  }
}

/* ---------------- one user ---------------- */
async function syncUser(uid: string) {
  const log: string[] = [];
  const items: Item[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("items").select("id,data").eq("user_id", uid).range(from, from + 999);
    if (error) throw error;
    items.push(...(data as Item[])); if (data.length < 1000) break;
  }
  const { data: metas } = await db.from("meta").select("key,data").eq("user_id", uid);
  const meta = Object.fromEntries((metas || []).map((m: any) => [m.key, m.data]));
  let tPatch = new Map<string, Record<string, any>>(), creates: Item[] = [];
  try {
    const r = await syncMal(uid, items, meta.mal, log);
    if (r) { tPatch = r.tPatch; creates = r.creates; await db.from("meta").upsert({ user_id: uid, key: "mal", data: r.baseline }); }
  } catch (e) { log.push(`! MAL: ${(e as Error).message}`); }
  await syncExophase(items, meta.exophase, tPatch, creates, log);

  const byId = new Map(items.map(i => [i.id, i]));
  const now = new Date().toISOString();
  for (const [id, patch] of tPatch) {
    const cur = byId.get(id); if (!cur) continue;
    await db.from("items").update({ data: { ...cur.data, ...patch }, updated_at: now }).eq("id", id).eq("user_id", uid);
  }
  if (creates.length) await db.from("items").upsert(creates.map(c => ({ id: c.id, user_id: uid, data: c.data, updated_at: now })));
  await db.from("meta").upsert({ user_id: uid, key: "lastsync", data: { at: now, log: log.slice(0, 200) } });
  return log;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const cron = req.headers.get("x-cron");
    if (cron) {
      const { data: s } = await db.from("sys").select("value").eq("key", "cron").maybeSingle();
      if (!s || s.value !== cron) return json({ error: "bad secret" }, 401);
      const { data: users } = await db.from("meta").select("user_id").eq("key", "exophase");
      const uids = new Set<string>((users || []).map((u: any) => u.user_id));
      const { data: toks } = await db.from("mal_tokens").select("user_id");
      (toks || []).forEach((t: any) => uids.add(t.user_id));
      const out: Record<string, number> = {};
      for (const uid of uids) out[uid] = (await syncUser(uid)).length;
      return json({ ok: true, users: out });
    }
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ error: "sign in first" }, 401);
    return json({ ok: true, log: await syncUser(u.user.id) });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
