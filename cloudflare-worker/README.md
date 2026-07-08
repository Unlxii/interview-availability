# Auto-deploy worker — one-time setup

This is the piece that lets admin.html publish `availability.json` straight to GitHub
with one tap, from any device, without copy-pasting into GitHub's web editor. The
GitHub-write credential lives only on Cloudflare's servers — never on your phone,
iPad, or any browser you use admin.html from.

None of these steps can be done for you — they require your own Cloudflare and
GitHub accounts. Takes about 10 minutes, done once.

## 1. Create a GitHub fine-grained PAT (scoped to this repo only)

1. github.com → your avatar → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
2. **Repository access**: "Only select repositories" → `interview-availability`
3. **Permissions** → **Repository permissions** → **Contents**: **Read and write** (leave everything else as "No access")
4. Generate, and copy the token immediately — GitHub only shows it once.

This token can touch *only* this one repo's contents. It cannot see your other repos, your account settings, or anything else — that scoping is the whole point.

## 2. Install wrangler and log in to Cloudflare

```bash
npm install -g wrangler
wrangler login   # opens a browser to authorize (free Cloudflare account is fine)
```

## 3. Deploy the worker

```bash
cd interview-availability/cloudflare-worker
wrangler deploy
```

This prints a URL like `https://availability-publish.YOUR-SUBDOMAIN.workers.dev` — save it, you'll need it in step 5.

## 4. Set the two secrets (never stored in any file, only on Cloudflare)

```bash
wrangler secret put GITHUB_TOKEN
# paste the PAT from step 1, press enter

wrangler secret put ADMIN_SECRET
# paste a long random string you generate yourself, e.g.:
#   openssl rand -hex 32
# (Linux/WSL/Mac have openssl built in; on Windows PowerShell use:
#   -join ((48..57)+(97..102)|Get-Random -Count 40|%{[char]$_}) )
```

`ADMIN_SECRET` is what admin.html sends to prove a request came from you — think of it as a second password, specific to publishing.

## 5. Configure admin.html

Open admin.html → **Publish** section → **⚙ auto-deploy settings** → paste:
- **Worker URL**: the `https://....workers.dev` URL from step 3
- **Shared secret**: the exact same string you set as `ADMIN_SECRET` in step 4

This is saved to that browser's `localStorage` only (same trust model as the existing password + 2FA lock).

## 6. Test it

Click **Publish now**. You should see `Published ✓` with a commit hash. Check the repo's commit history on GitHub — a new commit should appear immediately, tagged with `availability: update via admin (YYYY-MM-DD)`. The public page updates within ~1 minute (same Pages redeploy as before), and `validate-availability.yml` still runs as a safety net on that push.

## If a device is lost or compromised

Rotate the secret — this immediately locks out every device until you re-enter the new one:

```bash
wrangler secret put ADMIN_SECRET
# paste a new random string
```

If you ever suspect the GitHub PAT itself leaked (shouldn't happen — it never leaves Cloudflare's servers), revoke it from GitHub → Settings → Developer settings → Fine-grained tokens, then generate a new one and repeat step 4.

## Cost

Cloudflare Workers free tier: 100,000 requests/day. This uses a handful a week. $0.

## Note on custom domains

By default your worker lives at `https://your-worker.YOUR-SUBDOMAIN.workers.dev`, which admin.html's Content-Security-Policy already allows (`connect-src` includes `https://*.workers.dev`). If you later map the worker to a custom domain instead, add that origin to the CSP `connect-src` line near the top of admin.html, or the browser will silently block the publish request.

## Fallback

The old Download/Copy → paste into GitHub flow still works below the auto-deploy button in admin.html — nothing was removed, so if the worker is ever down or unconfigured, you're not blocked.
