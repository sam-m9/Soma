import { keyOf, dateFromKey, addDays, localParts, logicalNowInTZ, effectiveBase, dueProtocolsToday } from './schedule.js';
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

// Reads one secret regardless of how it's bound: a Secrets Store binding
// (an object with a .get() method) or a plain string var/secret.
async function secretValue(binding) {
  if (binding == null) return undefined;
  if (typeof binding === 'string') return binding;
  if (typeof binding.get === 'function') return await binding.get();
  return undefined;
}

// Loads all secrets once per request so the rest of the code just reads plain values.
async function loadSecrets(env) {
  const [APP_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET] = await Promise.all([
    secretValue(env.APP_SECRET),
    secretValue(env.VAPID_PUBLIC_KEY),
    secretValue(env.VAPID_PRIVATE_KEY),
    secretValue(env.VAPID_SUBJECT),
    secretValue(env.GOOGLE_CLIENT_ID),
    secretValue(env.GOOGLE_CLIENT_SECRET)
  ]);
  return { APP_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET };
}

function authorized(request, secrets) {
  const auth = request.headers.get('Authorization') || '';
  return !!secrets.APP_SECRET && auth === `Bearer ${secrets.APP_SECRET}`;
}

async function handlePushSend(env, secrets, subEntry, payload) {
  const vapid = {
    publicKey: secrets.VAPID_PUBLIC_KEY,
    privateKey: secrets.VAPID_PRIVATE_KEY,
    subject: secrets.VAPID_SUBJECT || 'mailto:you@example.com'
  };
  const res = await sendWebPush(subEntry.subscription, vapid, payload);
  if (res.status === 404 || res.status === 410) {
    // Subscription expired/gone — drop it so we stop retrying.
    await env.SOMA_KV.delete('push_sub');
  }
  return res;
}

async function checkReminders(env, secrets) {
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

  // Fires a single push per (day, protocol, kind) slot, deduped in KV so a
  // 5-minute cron never double-notifies within one target window.
  const fireOnce = async (slotKey, payload) => {
    const dedupeKey = `notified:${todayKey}:${slotKey}`;
    if (await env.SOMA_KV.get(dedupeKey)) return;
    await handlePushSend(env, secrets, subEntry, { ...payload, tag: dedupeKey });
    await env.SOMA_KV.put(dedupeKey, '1', { expirationTtl: 90000 });
  };
  const inWindow = target => nowMinutes >= target && nowMinutes < target + WINDOW;

  const due = dueProtocolsToday(state.protocols, today, today);
  for (const p of due) {
    if (!p.time) continue;
    const [hh, mm] = p.time.split(':').map(Number);
    const target = hh * 60 + mm;

    // Pre-injection fast: ping when the fasting window opens (e.g. 2 hr before CJC).
    if (p.fast && p.fast.beforeMin) {
      const preTarget = target - Number(p.fast.beforeMin);
      if (preTarget >= 0 && inWindow(preTarget)) {
        await fireOnce(`${p.id}:prefast`, {
          title: `${p.name} — begin fast`,
          body: 'Start your pre-injection fast now. Water only.',
          url: '/'
        });
      }
    }

    // The dose itself.
    if (inWindow(target)) {
      await fireOnce(p.id, {
        title: `${p.name} — ${p.amount}`,
        body: p.route ? `${p.route} · due now` : 'Due now',
        url: '/'
      });
    }

    // Post-injection fast: ping when it's safe to eat again (e.g. 30–45 min after CJC).
    if (p.fast && p.fast.afterMin) {
      const postTarget = target + Number(p.fast.afterMin);
      if (postTarget < 1440 && inWindow(postTarget)) {
        await fireOnce(`${p.id}:postfast`, {
          title: `${p.name} — fast complete`,
          body: 'Post-injection fast window is over. You can eat now.',
          url: '/'
        });
      }
    }
  }

  // Ketamine sessions have no per-entry time; check once at a fixed 08:00 slot.
  const KET_TIME = 8 * 60;
  if (inWindow(KET_TIME)) {
    const session = (state.ketSessions || []).find(s => s.date === todayKey && !s.done);
    if (session) {
      await fireOnce('ket', {
        title: 'Ketamine session scheduled today',
        body: session.dose ? `Planned dose: ${session.dose}` : 'Scheduled today',
        url: '/'
      });
    }
  }

  // Once-daily morning digest (09:00 local): low-noise, at most one push per topic.
  // Covers missed doses (yesterday), vial expiry/reorder, and pre-flight reconstitution.
  const MORNING = 9 * 60;
  if (inWindow(MORNING)) {
    const logs = state.logs || {};

    // (#7) Missed doses — evaluate the fully-finished previous day so a late dose
    // isn't flagged prematurely.
    const yKey = keyOf(addDays(today, -1));
    const yDate = dateFromKey(yKey);
    const yDoneDoses = (logs[yKey] || {}).doses || {};
    const missed = dueProtocolsToday(state.protocols, yDate, yDate).filter(p => !yDoneDoses[p.id]);
    if (missed.length) {
      await fireOnce('missed', {
        title: missed.length === 1 ? `Unlogged yesterday: ${missed[0].name}` : `${missed.length} doses unlogged yesterday`,
        body: missed.map(p => p.name).join(', ') + ' — tap to log if you took it.',
        url: '/'
      });
    }

    // (#6) Vial expiry / reorder — mirrors the app's Shelf math.
    for (const v of state.vials || []) {
      if (!v.reconDate) continue;
      const exp = addDays(dateFromKey(v.reconDate), Number(v.lifespanDays || 31));
      const daysLeft = Math.ceil((exp - today) / 86400000);
      let drawsLeft = null;
      const p = (state.protocols || []).find(x => x.id === v.protocolId);
      if (p && p.unit === 'U') {
        const doseMcg = effectiveBase(p, today);
        if (doseMcg && p.vialSizeMg) {
          const capacity = Math.floor((p.vialSizeMg * 1000) / doseMcg);
          let used = 0;
          Object.keys(logs).forEach(k => {
            if (k >= v.reconDate && logs[k].doses && logs[k].doses[p.id]) used++;
          });
          drawsLeft = Math.max(0, capacity - used);
        }
      }
      const thr = v.reorderAt == null ? 0 : Number(v.reorderAt);
      const lowDraws = drawsLeft != null && thr > 0 && drawsLeft <= thr;
      if (daysLeft < 0 || daysLeft <= 3 || lowDraws) {
        const parts = [daysLeft < 0 ? `expired ${Math.abs(daysLeft)}d ago` : `${daysLeft}d left`];
        if (lowDraws) parts.push(`${drawsLeft} draws left`);
        await fireOnce(`vial:${v.id}`, {
          title: `${v.name} vial — ${daysLeft < 0 ? 'expired' : 'running low'}`,
          body: parts.join(' · ') + '. Reconstitute a fresh vial soon.',
          url: '/'
        });
      }
    }

    // BAC water bottle: 30-day discard window from first puncture.
    for (const b of state.bacBottles || []) {
      if (!b.openDate) continue;
      const exp = addDays(dateFromKey(b.openDate), Number(b.lifespanDays || 30));
      const daysLeft = Math.ceil((exp - today) / 86400000);
      if (daysLeft < 0 || daysLeft <= 3) {
        await fireOnce(`bac:${b.id}`, {
          title: `BAC water — ${daysLeft < 0 ? 'expired' : 'discard soon'}`,
          body: (daysLeft < 0 ? `Opened bottle expired ${Math.abs(daysLeft)}d ago` : `${daysLeft}d left on the open bottle`) + '. Open a fresh one.',
          url: '/'
        });
      }
    }

    // (#8) Pre-flight: a compound starts within 3 days and no still-valid vial exists for it.
    for (const p of state.protocols || []) {
      if (p.status !== 'active' || !p.startDate) continue;
      const start = dateFromKey(p.startDate);
      const daysUntil = Math.round((start - today) / 86400000);
      if (daysUntil < 0 || daysUntil > 3) continue;
      const hasValidVial = (state.vials || []).some(v => {
        if (v.protocolId !== p.id || !v.reconDate) return false;
        const exp = addDays(dateFromKey(v.reconDate), Number(v.lifespanDays || 30));
        return exp >= start;
      });
      if (!hasValidVial) {
        await fireOnce(`preflight:${p.id}`, {
          title: `${p.name} starts ${daysUntil === 0 ? 'today' : 'in ' + daysUntil + 'd'}`,
          body: `Reconstitute your ${p.name} vial so it's ready in time.`,
          url: '/'
        });
      }
    }
  }
}

async function refreshGoogleAccessToken(secrets, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: secrets.GOOGLE_CLIENT_ID,
      client_secret: secrets.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.access_token;
}

const BACKUP_FOLDER_NAME = 'SOMA backup';

// Monday-of-the-week key in the given timezone, used purely to detect "a new
// week has started" for rotating the backup slot — independent of dosing.
function mondayKeyForTZ(tz) {
  const p = localParts(tz);
  const d = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  const wd = (d.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
  d.setUTCDate(d.getUTCDate() - wd);
  return keyOf(d);
}

async function driveFolderId(env, accessToken) {
  const cached = await env.SOMA_KV.get('backup_folder_id');
  if (cached) return cached;
  const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${BACKUP_FOLDER_NAME}' and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`Drive folder lookup failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  let id = body.files && body.files[0] && body.files[0].id;
  if (!id) {
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: BACKUP_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
    });
    if (!createRes.ok) throw new Error(`Drive folder create failed: ${createRes.status} ${await createRes.text()}`);
    id = (await createRes.json()).id;
  }
  await env.SOMA_KV.put('backup_folder_id', id);
  return id;
}

async function driveMultipart(url, method, accessToken, metadata, contentJson) {
  const boundary = 'soma-backup-boundary';
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: application/json\r\n\r\n' +
    `${contentJson}\r\n` +
    `--${boundary}--`;
  return fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
}

// Creates the file the first time, then renames + overwrites its content in
// place on every later call (same file ID, so it never clutters the folder
// with new copies — the title's date just reflects the latest write).
async function driveUpsertFile(env, accessToken, folderId, slot, title, contentJson) {
  const kvKey = `backup_file_${slot}`;
  let fileId = await env.SOMA_KV.get(kvKey);

  if (!fileId) {
    // One-time recovery if the KV cache was lost: find it by its stable slot prefix.
    const q = encodeURIComponent(`name contains 'SOMA backup ${slot}' and '${folderId}' in parents and trashed=false`);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (res.ok) {
      const body = await res.json();
      fileId = body.files && body.files[0] && body.files[0].id;
    }
  }

  const metadata = fileId ? { name: title } : { name: title, mimeType: 'application/json', parents: [folderId] };
  if (fileId) {
    const res = await driveMultipart(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`, 'PATCH', accessToken, metadata, contentJson);
    if (res.ok) {
      await env.SOMA_KV.put(kvKey, fileId);
      return fileId;
    }
    if (res.status !== 404) throw new Error(`Drive update failed: ${res.status} ${await res.text()}`);
    // file was deleted out from under us — fall through and recreate it
  }

  const res = await driveMultipart('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', 'POST', accessToken, metadata, contentJson);
  if (!res.ok) throw new Error(`Drive create failed: ${res.status} ${await res.text()}`);
  const file = await res.json();
  await env.SOMA_KV.put(kvKey, file.id);
  return file.id;
}

async function runBackup(env, secrets) {
  const tokens = await env.SOMA_KV.get('google_tokens', 'json');
  if (!tokens || !tokens.refresh_token) return { skipped: 'not connected' };
  const stateRaw = await env.SOMA_KV.get('state');
  if (!stateRaw) return { skipped: 'no state to back up' };

  const accessToken = await refreshGoogleAccessToken(secrets, tokens.refresh_token);
  const folderId = await driveFolderId(env, accessToken);

  const subEntry = await env.SOMA_KV.get('push_sub', 'json');
  const tz = (subEntry && subEntry.timezone) || 'UTC';
  const weekKey = mondayKeyForTZ(tz);
  const todayKey = keyOf(logicalNowInTZ(tz));

  // Two rotating slots: the current week's slot gets overwritten daily (fresh),
  // while the other slot sits untouched holding last week's final snapshot —
  // until it becomes "two weeks ago" and rotates back into use.
  let slot = (await env.SOMA_KV.get('backup_slot')) || 'A';
  const lastWeek = await env.SOMA_KV.get('backup_week_key');
  if (lastWeek !== weekKey) {
    slot = slot === 'A' ? 'B' : 'A';
    await env.SOMA_KV.put('backup_slot', slot);
    await env.SOMA_KV.put('backup_week_key', weekKey);
  }

  const title = `SOMA backup ${slot} — ${todayKey}.json`;
  const fileId = await driveUpsertFile(env, accessToken, folderId, slot, title, stateRaw);

  const lastBackup = { at: new Date().toISOString(), fileId, fileName: title, slot, weekKey };
  await env.SOMA_KV.put('last_backup', JSON.stringify(lastBackup));
  return lastBackup;
}

function googleRedirectUri(requestUrl) {
  return new URL('/auth/google/callback', requestUrl).toString();
}

async function handleFetch(request, env) {
  const url = new URL(request.url);
  const secrets = await loadSecrets(env);

  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

  if (url.pathname === '/auth/google/start') {
    if (!secrets.APP_SECRET || url.searchParams.get('key') !== secrets.APP_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!secrets.GOOGLE_CLIENT_ID) return new Response('GOOGLE_CLIENT_ID is not configured yet.', { status: 500 });
    const state = crypto.randomUUID();
    await env.SOMA_KV.put(`oauth_state:${state}`, '1', { expirationTtl: 300 });
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', secrets.GOOGLE_CLIENT_ID);
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
        client_id: secrets.GOOGLE_CLIENT_ID,
        client_secret: secrets.GOOGLE_CLIENT_SECRET,
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

  // Diagnostic: shows exactly what the Worker has stored and how it computes
  // "now" and each dose's fire time. Reachable two ways: the app's in-app
  // "Run diagnostics" button (Authorization header) or a browser link with
  // ?key=YOUR_APP_SECRET.
  if (url.pathname === '/api/diag') {
    const keyOk = secrets.APP_SECRET && url.searchParams.get('key') === secrets.APP_SECRET;
    if (!keyOk && !authorized(request, secrets)) {
      return new Response('Forbidden', { status: 403 });
    }
    const subEntry = await env.SOMA_KV.get('push_sub', 'json');
    const stateRaw = await env.SOMA_KV.get('state');
    const state = stateRaw ? JSON.parse(stateRaw) : null;
    const tz = (subEntry && subEntry.timezone) || 'UTC';
    const nowUTC = new Date();
    const lp = localParts(tz, nowUTC);
    const today = logicalNowInTZ(tz, nowUTC);
    const fmtMin = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(((m % 60) + 60) % 60).padStart(2, '0');
    const due = state ? dueProtocolsToday(state.protocols, today, today) : [];
    return json({
      serverTimeUTC: nowUTC.toISOString(),
      pushSubscriptionOnFile: !!subEntry,
      timezoneStored: subEntry ? (subEntry.timezone || '(missing — defaults to UTC!)') : '(no subscription)',
      localNow: `${String(lp.h).padStart(2, '0')}:${String(lp.mi).padStart(2, '0')} on ${keyOf(today)}`,
      stateOnFile: !!state,
      dueTodayCount: due.length,
      dueToday: due.map(p => ({
        name: p.name,
        doseTime: p.time,
        firesAt: p.time,
        prefast: p.fast && p.fast.beforeMin ? fmtMin((Number(p.time.split(':')[0]) * 60 + Number(p.time.split(':')[1])) - Number(p.fast.beforeMin)) : null,
        postfast: p.fast && p.fast.afterMin ? fmtMin((Number(p.time.split(':')[0]) * 60 + Number(p.time.split(':')[1])) + Number(p.fast.afterMin)) : null
      })),
      allProtocolTimes: state ? (state.protocols || []).filter(p => p.kind === 'peptide').map(p => ({ name: p.name, time: p.time, start: p.startDate, status: p.status })) : []
    });
  }

  if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
  if (!authorized(request, secrets)) return json({ error: 'unauthorized' }, { status: 401 });

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
    const res = await handlePushSend(env, secrets, subEntry, {
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
      const result = await runBackup(env, secrets);
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
    const secrets = await loadSecrets(env);
    if (event.cron === '*/5 * * * *') {
      ctx.waitUntil(checkReminders(env, secrets));
    } else {
      ctx.waitUntil(runBackup(env, secrets));
    }
  }
};
