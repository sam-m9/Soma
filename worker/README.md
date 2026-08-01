# soma-api

A small Cloudflare Worker that gives the static Soma app two things it can't
do on its own as a plain HTML page:

1. **Real push reminders** — fires at each protocol's scheduled time, even if
   the app/phone is closed (checked every 5 minutes via Cron Trigger).
2. **Automatic Google Drive backup** — uploads your full app state as a dated
   JSON file once a day (also via Cron Trigger), so it isn't only sitting in
   browser `localStorage`.

This is a separate deployment from the Soma static site (which stays on
Cloudflare Pages). It's a single-user tool — auth is one shared secret, not
per-user accounts.

## 1. One-time setup

You'll need Node.js installed locally to run these commands.

```bash
cd worker
npm install
npx wrangler login          # opens a browser to authorize your Cloudflare account
```

Create the KV namespace the Worker stores everything in:

```bash
npx wrangler kv namespace create SOMA_KV
```

That prints an `id`. Paste it into `worker/wrangler.toml`, replacing
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

## 2. Set secrets

Each command prompts you to paste a value.

```bash
npx wrangler secret put APP_SECRET
```
Paste any long random string (e.g. generate one with `openssl rand -hex 32`).
This is the "API key" you'll paste into Soma's Reminders & Cloud Backup card
— treat it like a password.

```bash
npx wrangler secret put VAPID_PUBLIC_KEY
```
Paste: `BME5aepc23cm_AKyxh5IfR-AcJtYSR-yApWVBCmcXTUKFjlwqmfRGb7swtb8lMceHnAgH8gkJJ0tidKK-uMky4c`

```bash
npx wrangler secret put VAPID_PRIVATE_KEY
```
Paste: `xMxYmjLlG3qF-p725YAj49XjLUvnxa8H-AxemV6zRN0`

(These two are a matched pair generated for this project — the public half is
already baked into `index.html`. Keep the private one secret; if you ever
need to rotate it, generate a fresh pair and update both places.)

```bash
npx wrangler secret put VAPID_SUBJECT
```
Paste `mailto:you@example.com` (any contact address — push services want one
in case they need to reach you about your app).

## 3. Google Cloud OAuth client (for Drive backup)

Only needed if you want the automatic Drive backup. Push reminders work
without this.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create a
   project (or reuse one).
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → External → fill the required
   fields → add yourself as a **test user** (testing mode is fine, this app
   is just for you).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   → Application type: **Web application**.
5. Deploy the Worker first (next section) so you know its URL, then come back
   and add this **Authorized redirect URI**:
   `https://soma-api.<your-subdomain>.workers.dev/auth/google/callback`
   (find `<your-subdomain>` on your Cloudflare Workers dashboard overview).
6. Copy the **Client ID** and **Client secret**, then:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

## 4. Deploy

```bash
npx wrangler deploy
```

This prints your Worker's URL, e.g. `https://soma-api.<subdomain>.workers.dev`.

## 5. Connect the app

Open Soma → **Plans** tab → **Reminders & Cloud Backup** card:

1. Paste the Worker URL and the `APP_SECRET` you generated → **Save**.
2. **Enable push reminders** — grants notification permission and subscribes
   this device.
3. **Send test push** — confirms it actually works end to end.
4. **Connect Google Drive** — opens a Google consent tab; approve, then close
   it. (Skip this if you didn't set up the OAuth client.)
5. **Back up now** — triggers an immediate backup so you can confirm a file
   shows up in your Drive.

From here, dose reminders fire automatically at each protocol's scheduled
time, and Drive backups run once a day, with no further action needed.

## Notes

- **Dates aren't hardcoded anywhere.** The Worker re-derives "what's due
  today" from each protocol's own `startDate`/schedule/pauses on every check
  — same engine the app itself uses (`src/schedule.js` is a direct port). If
  you push your protocol start date from Wednesday to Thursday in the app,
  the Worker picks that up on the next sync automatically.
- **Adjust the daily backup time** by editing the second cron expression in
  `wrangler.toml` (`0 13 * * *` = 13:00 UTC) and redeploying.
- **Vial lifespan** used by the app's inventory countdown is 31 days from
  reconstitution.
- Drive backups use the `drive.file` scope, so the Worker can only see files
  it created — it never has broader access to your Drive.
