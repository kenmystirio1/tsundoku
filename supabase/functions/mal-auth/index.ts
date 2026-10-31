// Tsundoku "mal-auth": MyAnimeList sign-in callback.
// The app stores {state, verifier} for the signed-in user, sends the browser to MAL,
// MAL sends it back here with ?code&state, and we swap the code for tokens.
// Deploy with JWT verification OFF (MAL's redirect carries no Supabase token).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const MAL_CLIENT_ID = Deno.env.get("MAL_CLIENT_ID") || "";
const APP_URL = "https://kenmystirio1.github.io/tsundoku/";
const SELF = `${Deno.env.get("SUPABASE_URL")}/functions/v1/mal-auth`;
const back = (q: string) => Response.redirect(`${APP_URL}?mal=${q}`, 302);

Deno.serve(async (req) => {
  const p = new URL(req.url).searchParams;
  const code = p.get("code"), state = p.get("state");
  if (p.get("error") || !code || !state) return back("cancelled");
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: row } = await db.from("mal_oauth").select("user_id, verifier").eq("state", state).maybeSingle();
  if (!row) return back("expired");
  const r = await fetch("https://myanimelist.net/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: MAL_CLIENT_ID, grant_type: "authorization_code", code, code_verifier: row.verifier, redirect_uri: SELF }),
  });
  const t = await r.json();
  if (!r.ok || !t.access_token) return back("failed");
  await db.from("mal_tokens").upsert({
    user_id: row.user_id, access_token: t.access_token, refresh_token: t.refresh_token,
    expires_at: new Date(Date.now() + (t.expires_in - 300) * 1000).toISOString(),
  });
  await db.from("mal_oauth").delete().eq("user_id", row.user_id);
  return back("connected");
});
