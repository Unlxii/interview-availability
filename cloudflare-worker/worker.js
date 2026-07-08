/*
 * availability-publish worker
 * ----------------------------
 * Holds the GitHub write credential server-side so no device ever carries
 * a repo-write-capable secret. admin.html POSTs the new availability.json
 * content here (with a shared secret header); this worker validates it
 * (same rules as .github/workflows/validate-availability.yml, run again
 * here as defense in depth) and commits it to GitHub via the Contents API.
 *
 * Secrets (set with `wrangler secret put <NAME>` — never written to this file
 * or committed anywhere):
 *   GITHUB_TOKEN  - fine-grained PAT, scoped to ONLY this repo,
 *                   permission: Contents = Read and write (nothing else)
 *   ADMIN_SECRET  - a long random string; admin.html must send this back
 *                   to prove the request came from your own device
 *
 * Plain vars (not secret, safe to keep in wrangler.toml):
 *   GITHUB_OWNER, GITHUB_REPO
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (url.pathname !== "/publish") return cors(json({ ok: false, error: "not found" }, 404));
    if (request.method !== "POST") return cors(json({ ok: false, error: "method not allowed" }, 405));

    const secret = request.headers.get("X-Admin-Secret") || "";
    if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
      return cors(json({ ok: false, error: "unauthorized" }, 401));
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return cors(json({ ok: false, error: "invalid JSON body" }, 400));
    }

    const err = validate(body);
    if (err) return cors(json({ ok: false, error: err }, 400));

    // server-side "updated" stamp too — belt and suspenders against a stale client clock
    body.updated = new Date().toISOString().slice(0, 10);

    try {
      const result = await commitToGitHub(body, env);
      return cors(json({ ok: true, commit: result.sha, updated: body.updated }));
    } catch (e) {
      return cors(json({ ok: false, error: String((e && e.message) || e) }, 502));
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

// admin.html is opened via file:// or a hosted origin different from the worker's own
// origin, so the browser will preflight/enforce CORS — allow it explicitly.
function cors(res) {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Secret");
  return res;
}

/* ---- validation: mirrors .github/workflows/validate-availability.yml ---- */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const TAG_COLORS = [
  "rose", "pink", "fuchsia", "purple", "violet", "indigo", "blue", "sky",
  "cyan", "teal", "emerald", "lime", "yellow", "amber", "orange", "slate",
];

function validate(d) {
  if (typeof d !== "object" || d === null) return "body must be an object";
  if (!["open", "limited", "busy"].includes(d.status)) return "status must be open|limited|busy";
  if (!Array.isArray(d.busy)) return "busy must be an array";

  if (d.focus !== undefined) {
    if (!Array.isArray(d.focus)) return "focus must be an array of strings";
    for (const [i, f] of d.focus.entries())
      if (typeof f !== "string" || f.length > 60) return `focus[${i}]: must be a string <= 60 chars`;
  }
  if (d.gaming !== undefined) {
    if (!Array.isArray(d.gaming)) return "gaming must be an array";
    if (d.gaming.length > 8) return "gaming: max 8 tags";
    const URLRE = /^https?:\/\//i;
    for (const [i, g] of d.gaming.entries()) {
      if (typeof g.label !== "string" || !g.label.trim() || g.label.length > 40)
        return `gaming[${i}]: label must be a non-empty string <= 40 chars`;
      if (g.url !== undefined && (typeof g.url !== "string" || !URLRE.test(g.url) || g.url.length > 300))
        return `gaming[${i}]: url must be http(s) and <= 300 chars`;
    }
  }
  if (d.certs !== undefined) {
    if (!Array.isArray(d.certs)) return "certs must be an array";
    if (d.certs.length > 30) return "certs: max 30 entries";
    for (const [i, c] of d.certs.entries()) {
      if (typeof c.name !== "string" || !c.name.trim() || c.name.length > 120)
        return `certs[${i}]: name must be a non-empty string <= 120 chars`;
      if (c.issuer !== undefined && (typeof c.issuer !== "string" || c.issuer.length > 120))
        return `certs[${i}]: issuer must be a string <= 120 chars`;
      if (c.meta !== undefined && (typeof c.meta !== "string" || c.meta.length > 160))
        return `certs[${i}]: meta must be a string <= 160 chars`;
      if (c.url !== undefined && (typeof c.url !== "string" || c.url.length > 300 ||
          (c.url.includes(":") && !/^https?:\/\//i.test(c.url))))
        return `certs[${i}]: url must be http(s), a relative path, or omitted`;
    }
  }
  if (d.statusText !== undefined) {
    if (typeof d.statusText !== "object" || d.statusText === null || Array.isArray(d.statusText))
      return "statusText must be an object";
    for (const k of ["open", "limited", "busy"])
      if (d.statusText[k] !== undefined && (typeof d.statusText[k] !== "string" || d.statusText[k].length > 140))
        return `statusText.${k} must be a string <= 140 chars`;
  }

  for (const [i, b] of d.busy.entries()) {
    if (!DATE_RE.test(String(b.from)) || !DATE_RE.test(String(b.to))) return `busy[${i}]: from/to must be YYYY-MM-DD`;
    if (b.to < b.from) return `busy[${i}]: reversed range (${b.from} > ${b.to})`;
    if (b.time && !TIME_RE.test(b.time)) return `busy[${i}]: time must be HH:MM-HH:MM`;
    if (b.kind !== undefined && !["flex", "exam", "interview", "exercise", "activity", "feedback"].includes(b.kind))
      return `busy[${i}]: invalid kind`;
    if (typeof (b.label ?? "") !== "string" || String(b.label || "").length > 120)
      return `busy[${i}]: label must be a string <= 120 chars`;
    if (b.color !== undefined && !TAG_COLORS.includes(b.color)) return `busy[${i}]: invalid color`;
    if (b.free !== undefined && typeof b.free !== "boolean") return `busy[${i}]: free must be a boolean`;
  }
  return null; // valid
}

/* ---- GitHub Contents API commit ---- */
async function commitToGitHub(newContent, env) {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = env;
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) throw new Error("worker misconfigured — missing GITHUB_TOKEN/OWNER/REPO");

  const path = "availability.json";
  const api = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    "User-Agent": "availability-publish-worker",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // 1) current file's sha is required by the Contents API for any update
  const getRes = await fetch(api, { headers });
  if (!getRes.ok) throw new Error(`GitHub GET failed: ${getRes.status}`);
  const cur = await getRes.json();

  // 2) commit the new content
  const contentStr = JSON.stringify(newContent, null, 2) + "\n";
  const putRes = await fetch(api, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      message: `availability: update via admin (${newContent.updated})`,
      content: b64encode(contentStr),
      sha: cur.sha,
    }),
  });
  if (!putRes.ok) {
    const errBody = await putRes.text();
    throw new Error(`GitHub PUT failed: ${putRes.status} ${errBody}`);
  }
  const putJson = await putRes.json();
  return { sha: putJson.commit && putJson.commit.sha };
}

// Workers' btoa only safely handles Latin1 — this encodes UTF-8 correctly
// (matters here since labels can contain Thai text).
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
