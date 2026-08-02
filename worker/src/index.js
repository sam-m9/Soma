import { keyOf, localParts, logicalNowInTZ, dueProtocolsToday } from './schedule.js';
import { sendWebPush } from './webpush.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type'
};

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...CORS, ...(init.headers || {}) }
  });
}

function authorized(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return auth === `Bearer ${env.APP_SECRET}`;
}

async function handlePushSend(env, subEntry, payload) {
  const vapid = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || 'mailto:you@example.com'
  };
  const res = await sendWebPush(subEntry.subscription, vapid, payload);
  if (res.status === 404 || res.status === 410) {
    // Subscription expired/gone — drop it so we stop retrying.
    await env.SOMA_KV.delete('push_sub');
  }
  return res;
}

async function checkReminders(env) {
  const subEntry = await env.SOMA_KV.get('push_sub', 'json');
  if (!subEntry) return;
  const stateRaw = await env.SOMA_KV.get('state');
  if (!stateRaw) return;
  const state = JSON.parse(stateRaw);
  const tz = subEntry.timezone || 'UTC';
  const today = logicalNowInTZ(tz);
  const todayKey = keyOf(today);
  const now = localParts(tz);
  const nowMinutes = now.h * 60 + now.mi;
  const WINDOW = 5; // matches the cron cadence below

  const due = dueProtocolsToday(state.protocols, today, today);
  for (const p of due) {
    if (!p.time) continue;
    const [hh, mm] = p.time.split(':').map(Number);
    const target = hh * 60 + mm;
    if (nowMinutes < target || nowMinutes >= target + WINDOW) continue;
    const dedupeKey = `notified:${todayKey}:${p.id}`;
    if (await env.SOMA_KV.get(dedupeKey)) continue;
    await handlePushSend(env, subEntry, {
      title: `${p.name} — ${p.amount}`,
      body: p.route ? `${p.route} · due now` : 'Due now',
      tag: dedupeKey,
      url: '/'
    });
    await env.SOMA_KV.put(dedupeKey, '1', { expirationTtl: 90000 });
  }

  // Ketamine sessions have no per-entry time; check once at a fixed 08:00 slot.
  const KET_TIME = 8 * 60;
  if (nowMinutes >= KET_TIME && nowMinutes < KET_TIME + WINDOW) {
    const session = (state.ketSessions || []).find(s => s.date === todayKey && !s.done);
    if (session) {
      const dedupeKey = `notified:${todayKey}:ket`;
      if (!(await env.SOMA_KV.get(dedupeKey))) {
        await handlePushSend(env, subEntry, {
          title: 'Ketamine session scheduled today',
          body: session.dose ? `Planned dose: ${session.dose}` : 'Scheduled today',
          tag: dedupeKey,
          url: '/'
        });
        await env.SOMA_KV.put(dedupeKey, '1', { expirationTtl: 90000 });
      }
    }
  }
}

async function refreshGoogleAccessToken(env, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.access_token;
}

async function runBackup(env) {
  const tokens = await env.SOMA_KV.get('google_tokens', 'json');
  if (!tokens || !tokens.refresh_token) return { skipped: 'not connected' };
  const stateRaw = await env.SOMA_KV.get('state');
  if (!stateRaw) return { skipped: 'no state to back up' };

  const accessToken = await refreshGoogleAccessToken(env, tokens.refresh_token);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `soma-backup-${stamp}.json`;

  const boundary = 'soma-backup-boundary';
  const metadata = { name: filename, mimeType: 'application/json' };
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: application/json\r\n\r\n' +
    `${stateRaw}\r\n` +
    `--${boundary}--`;

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body
  });
  if (!res.ok) throw new Error(`Drive upload failed: ${res.status} ${await res.text()}`);
  const file = await res.json();

  const lastBackup = { at: new Date().toISOString(), fileId: file.id, fileName: filename };
  await env.SOMA_KV.put('last_backup', JSON.stringify(lastBackup));
  return lastBackup;
}

function googleRedirectUri(requestUrl) {
  return new URL('/auth/google/callback', requestUrl).toString();
}

async function handleFetch(request, env) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

  if (url.pathname === '/auth/google/start') {
    if (url.searchParams.get('key') !== env.APP_SECRET) return new Response('Forbidden', { status: 403 });
    const state = crypto.randomUUID();
    await env.SOMA_KV.put(`oauth_state:${state}`, '1', { expirationTtl: 300 });
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', googleRedirectUri(request.url));
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/drive.file');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', state);
    return Response.redirect(authUrl.toString(), 302);
  }

  if (url.pathname === '/auth/google/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const stateKey = `oauth_state:${state}`;
    if (!state || !(await env.SOMA_KV.get(stateKey))) return new Response('Invalid or expired state', { status: 403 });
    await env.SOMA_KV.delete(stateKey);
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(request.url),
        grant_type: 'authorization_code'
      })
    });
    if (!tokenRes.ok) return new Response(`Google auth failed: ${await tokenRes.text()}`, { status: 500 });
    const tokenBody = await tokenRes.json();
    const existing = (await env.SOMA_KV.get('google_tokens', 'json')) || {};
    const refresh_token = tokenBody.refresh_token || existing.refresh_token;
    if (!refresh_token) {
      return new Response('No refresh token returned — revoke Soma\'s access at myaccount.google.com/permissions and try again so Google issues a fresh one.', { status: 500 });
    }
    await env.SOMA_KV.put('google_tokens', JSON.stringify({ refresh_token }));
    return new Response('<h1>Google Drive connected</h1><p>You can close this tab.</p>', {
      headers: { 'Content-Type': 'text/html' }
    });
  }

  // Temporary diagnostic — remove once auth is confirmed working.
  // Visit /api/debug?key=whatever in a browser to check if it matches the deployed secret.
  if (url.pathname === '/api/debug') {
    const provided = url.searchParams.get('key') || '';
    return json({
      secretConfigured: typeof env.APP_SECRET === 'string' && env.APP_SECRET.length > 0,
      match: provided === env.APP_SECRET,
      authHeaderReceived: request.headers.get('Authorization') || null
    });
  }

  if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
  if (!authorized(request, env)) return json({ error: 'unauthorized' }, { status: 401 });

  if (url.pathname === '/api/state' && request.method === 'GET') {
    const stateRaw = await env.SOMA_KV.get('state');
    return stateRaw ? new Response(stateRaw, { headers: { 'Content-Type': 'application/json', ...CORS } }) : json(null);
  }

  if (url.pathname === '/api/state' && request.method === 'PUT') {
    const body = await request.text();
    JSON.parse(body); // validate
    await env.SOMA_KV.put('state', body);
    return json({ ok: true });
  }

  if (url.pathname === '/api/push/subscribe' && request.method === 'POST') {
    const body = await request.json();
    await env.SOMA_KV.put('push_sub', JSON.stringify(body));
    return json({ ok: true });
  }

  if (url.pathname === '/api/push/unsubscribe' && request.method === 'POST') {
    await env.SOMA_KV.delete('push_sub');
    return json({ ok: true });
  }

  if (url.pathname === '/api/push/test' && request.method === 'POST') {
    const subEntry = await env.SOMA_KV.get('push_sub', 'json');
    if (!subEntry) return json({ error: 'no subscription on file' }, { status: 400 });
    const res = await handlePushSend(env, subEntry, {
      title: 'Soma test reminder',
      body: 'Push notifications are working.',
      tag: 'test',
      url: '/'
    });
    return json({ ok: res.ok, status: res.status });
  }

  if (url.pathname === '/api/backup/status' && request.method === 'GET') {
    const tokens = await env.SOMA_KV.get('google_tokens', 'json');
    const lastBackup = await env.SOMA_KV.get('last_backup', 'json');
    return json({ connected: !!(tokens && tokens.refresh_token), lastBackup: lastBackup || null });
  }

  if (url.pathname === '/api/backup/run' && request.method === 'POST') {
    try {
      const result = await runBackup(env);
      return json({ ok: true, result });
    } catch (err) {
      return json({ ok: false, error: String(err) }, { status: 500 });
    }
  }

  return json({ error: 'not found' }, { status: 404 });
}

export default {
  fetch(request, env, ctx) {
    return handleFetch(request, env);
  },
  async scheduled(event, env, ctx) {
    // wrangler.toml defines two cron triggers: the 5-minute one drives dose
    // reminders, the daily one drives the Google Drive backup.
    if (event.cron === '*/5 * * * *') {
      ctx.waitUntil(checkReminders(env));
    } else {
      ctx.waitUntil(runBackup(env));
    }
  }
};
