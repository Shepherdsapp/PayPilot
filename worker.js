// PayPilot Cloud — Cloudflare Worker  ·  deploy as worker name "paypilot" → https://paypilot.8pavii.workers.dev
// Bind the SAME KV namespace the old creditflow-sync worker used (creditflow-data) so all data carries over.
//
// Bindings (Workers & Pages → paypilot → Settings):
//   KV namespace  CREDITFLOW_KV  →  creditflow-data   (the existing store — your data is already in it)
//   Secret        SYNC_SECRET            16+ random characters. Also typed once into PayPilot on each device.
//   Secret        VIEW_SECRET            (optional) key for the read-only manager link
//   Secret        GOOGLE_CLIENT_ID       (optional) for "Gmail through Cloudflare" — never expires
//   Secret        GOOGLE_CLIENT_SECRET   (optional) same
//   Variable      ALLOWED_ORIGIN         (optional) e.g. https://sitbackco.github.io  — locks the API to your site
//
// Endpoints: /ping · GET|PUT /data · /backups · /restore?day= · GET|PUT /view
//            /gauth/start?k= · /gauth/callback · /gauth/token · /gauth/status

const SCOPES = 'https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.readonly';

function cors(env, req) {
  const origin = req.headers.get('origin') || '';
  const allow = env.ALLOWED_ORIGIN ? (env.ALLOWED_ORIGIN.split(',').map(s => s.trim()).includes(origin) ? origin : env.ALLOWED_ORIGIN.split(',')[0].trim()) : '*';
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS', 'Access-Control-Allow-Headers': 'content-type,x-sync-key,x-view-key', 'Vary': 'Origin' };
}
function json(obj, status, h) { return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json', ...h } }); }
// constant-time compare
function same(a, b) { a = String(a || ''); b = String(b || ''); if (!a || !b || a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
function html(body, status) { return new Response('<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;padding:40px;max-width:560px;margin:auto;color:#0d1a2b">' + body + '</body>', { status: status || 200, headers: { 'content-type': 'text/html; charset=utf-8' } }); }

async function refreshAccess(env) {
  const rt = await env.CREDITFLOW_KV.get('gmail_refresh');
  if (!rt) return null;
  const cached = await env.CREDITFLOW_KV.get('gmail_access', 'json');
  if (cached && cached.exp > Date.now() + 120000) return cached;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: rt, grant_type: 'refresh_token' }) });
  const d = await r.json();
  if (!d.access_token) return { error: d.error || 'refresh_failed' };
  const out = { access_token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000, email: (await env.CREDITFLOW_KV.get('gmail_email')) || '' };
  await env.CREDITFLOW_KV.put('gmail_access', JSON.stringify(out), { expirationTtl: Math.max(60, (d.expires_in || 3600) - 60) });
  return out;
}

export default {
  async fetch(request, env) {
    const C = cors(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { headers: C });
    const url = new URL(request.url);
    const p = url.pathname;
    const key = request.headers.get('x-sync-key') || '';
    const authed = env.SYNC_SECRET && same(key, env.SYNC_SECRET);

    // ── read-only view for the manager (own key) ──
    if (p === '/view' && request.method === 'GET') {
      if (!env.VIEW_SECRET || !same(request.headers.get('x-view-key'), env.VIEW_SECRET)) return json({ error: 'unauthorised' }, 401, C);
      const v = await env.CREDITFLOW_KV.get('view');
      return new Response(v || 'null', { headers: { 'content-type': 'application/json', ...C } });
    }

    // ── Gmail OAuth (browser redirects, so the sync key comes in the query string once) ──
    if (p === '/gauth/start') {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return html('<h2>Not set up</h2><p>Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the worker first.</p>', 500);
      if (!env.SYNC_SECRET || env.SYNC_SECRET.length < 16 || !same(url.searchParams.get('k'), env.SYNC_SECRET)) return html('<h2>Not allowed</h2><p>Your sync key is wrong or shorter than 16 characters.</p>', 401);
      const state = crypto.randomUUID();
      await env.CREDITFLOW_KV.put('gauth_state:' + state, '1', { expirationTtl: 600 });
      const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: url.origin + '/gauth/callback', response_type: 'code', scope: SCOPES, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
      return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q, 302);
    }
    if (p === '/gauth/callback') {
      const state = url.searchParams.get('state') || '', code = url.searchParams.get('code');
      if (!state || !(await env.CREDITFLOW_KV.get('gauth_state:' + state))) return html('<h2>Link expired</h2><p>Start again from PayPilot → Settings → Gmail.</p>', 400);
      await env.CREDITFLOW_KV.delete('gauth_state:' + state);
      if (!code) return html('<h2>Cancelled</h2><p>' + (url.searchParams.get('error') || '') + '</p>', 400);
      const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: url.origin + '/gauth/callback', grant_type: 'authorization_code' }) });
      const d = await r.json();
      if (!d.refresh_token) return html('<h2>No long-term access returned</h2><p>' + (d.error_description || d.error || 'Remove PayPilot from your Google account permissions and try again.') + '</p>', 400);
      await env.CREDITFLOW_KV.put('gmail_refresh', d.refresh_token);
      let email = '';
      try { const pr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: 'Bearer ' + d.access_token } }); email = (await pr.json()).emailAddress || ''; } catch (e) {}
      await env.CREDITFLOW_KV.put('gmail_email', email);
      await env.CREDITFLOW_KV.delete('gmail_access');
      return html('<h2>✅ Gmail connected to PayPilot</h2><p>' + email + '</p><p>You can close this tab. Every device now has Gmail without signing in again.</p>');
    }

    if (!authed) return json({ error: 'unauthorised' }, 401, C);

    if (p === '/ping') return json({ ok: true, service: 'paypilot-sync', gmail: !!(await env.CREDITFLOW_KV.get('gmail_refresh')), view: !!env.VIEW_SECRET, strongKey: env.SYNC_SECRET.length >= 16 }, 200, C);

    if (p === '/gauth/token') {
      if (env.SYNC_SECRET.length < 16) return json({ error: 'sync key too short for Gmail' }, 403, C);
      if (!env.GOOGLE_CLIENT_ID) return json({ error: 'not configured' }, 404, C);
      const t = await refreshAccess(env);
      if (!t) return json({ error: 'not connected' }, 404, C);
      if (t.error) return json({ error: t.error }, 502, C);
      return json({ access_token: t.access_token, expires_in: Math.floor((t.exp - Date.now()) / 1000), email: t.email }, 200, C);
    }
    if (p === '/gauth/status') return json({ connected: !!(await env.CREDITFLOW_KV.get('gmail_refresh')), email: (await env.CREDITFLOW_KV.get('gmail_email')) || '' }, 200, C);

    if (p === '/data' && request.method === 'GET') {
      const snap = await env.CREDITFLOW_KV.get('snapshot');
      return new Response(snap || 'null', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...C } });
    }
    if (p === '/data' && request.method === 'PUT') {
      const body = await request.text();
      if (!body || body.length > 24 * 1024 * 1024) return json({ error: 'bad payload' }, 400, C);
      let parsed; try { parsed = JSON.parse(body); } catch (e) { return json({ error: 'not json' }, 400, C); }
      if (!parsed || !parsed._savedAt) return json({ error: 'missing _savedAt' }, 400, C);
      await env.CREDITFLOW_KV.put('snapshot', body);
      const day = new Date().toISOString().slice(0, 10);
      if (!(await env.CREDITFLOW_KV.get('backup:' + day))) await env.CREDITFLOW_KV.put('backup:' + day, body, { expirationTtl: 60 * 86400 });
      return json({ ok: true, savedAt: parsed._savedAt }, 200, C);
    }
    if (p === '/view' && request.method === 'PUT') {
      const body = await request.text();
      if (!body || body.length > 4 * 1024 * 1024) return json({ error: 'bad payload' }, 400, C);
      await env.CREDITFLOW_KV.put('view', body);
      return json({ ok: true }, 200, C);
    }
    if (p === '/backups') {
      const list = await env.CREDITFLOW_KV.list({ prefix: 'backup:' });
      return json({ backups: list.keys.map(k => k.name.replace('backup:', '')) }, 200, C);
    }
    if (p === '/restore') {
      const day = url.searchParams.get('day'); if (!day) return json({ error: 'missing day' }, 400, C);
      const snap = await env.CREDITFLOW_KV.get('backup:' + day);
      return new Response(snap || 'null', { headers: { 'content-type': 'application/json', ...C } });
    }
    return json({ error: 'not found' }, 404, C);
  }
};
