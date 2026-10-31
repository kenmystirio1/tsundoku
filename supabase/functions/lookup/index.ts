// Tsundoku "lookup": search proxy for sources that browsers can't call directly.
//   ?src=comicvine&q=Batman&page=1      → comic series (volumes) from ComicVine
//   ?src=comicvine-volume&id=796        → creators of one series
//   ?src=steam&q=hades                  → games from the Steam store
//   ?src=steam-app&id=1145360           → developer, year, cover of one Steam game
// Needs the COMICVINE_KEY secret. Called by the app with the signed-in user's token.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const UA = { "User-Agent": "Tsundoku personal tracker" };
const strip = (h = "") => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function comicvine(path: string, params: Record<string, string>) {
  const key = Deno.env.get("COMICVINE_KEY");
  if (!key) throw new Error("COMICVINE_KEY secret is missing");
  const u = new URL(`https://comicvine.gamespot.com/api/${path}`);
  u.search = new URLSearchParams({ api_key: key, format: "json", ...params }).toString();
  const r = await fetch(u, { headers: UA });
  const j = await r.json();
  if (j.status_code !== 1) throw new Error(j.error || "ComicVine error");
  return j;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const p = new URL(req.url).searchParams;
  const src = p.get("src"), q = (p.get("q") || "").trim(), id = p.get("id") || "", page = Math.max(1, +(p.get("page") || 1));
  try {
    if (src === "comicvine") {
      const j = await comicvine("search/", {
        query: q, resources: "volume", limit: "20", page: String(page),
        field_list: "id,name,start_year,publisher,count_of_issues,image,deck,description",
      });
      return json({ options: (j.results || []).map((v: any) => ({
        title: v.start_year ? `${v.name} (${v.start_year})` : v.name,
        years: v.start_year || "",
        publisher: v.publisher?.name || "",
        total: Number.isInteger(+v.count_of_issues) ? +v.count_of_issues : null,
        unit: "issues",
        note: strip(v.deck || "").slice(0, 80) || (strip(v.description || "").slice(0, 60) + (v.description ? "…" : "")),
        cover: v.image?.medium_url || v.image?.small_url || "",
        cvId: v.id,
      })) });
    }
    if (src === "comicvine-volume") {
      const j = await comicvine(`volume/4050-${encodeURIComponent(id)}/`, { field_list: "people,count_of_issues,last_issue,start_year" });
      const people = (j.results?.people || []).sort((a: any, b: any) => (b.count || 0) - (a.count || 0)).slice(0, 3).map((x: any) => x.name);
      return json({ author: people.join(", "), total: +j.results?.count_of_issues || null });
    }
    if (src === "steam") {
      const r = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&l=english&cc=US`, { headers: UA });
      const j = await r.json();
      return json({ options: (j.items || []).map((g: any) => ({
        title: g.name, steamId: g.id, years: "", total: null, note: "Steam",
        cover: `https://cdn.akamai.steamstatic.com/steam/apps/${g.id}/library_600x900.jpg`,
      })) });
    }
    if (src === "steam-app") {
      const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(id)}&l=english`, { headers: UA });
      const d = (await r.json())?.[id]?.data || {};
      return json({ author: (d.developers || []).join(", "), publisher: (d.publishers || [])[0] || "", years: (d.release_date?.date || "").match(/\d{4}/)?.[0] || "" });
    }
    return json({ error: "unknown src" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 502);
  }
});
