// Vocab flashcards server: serves index.html and stores each user's progress.
// No dependencies; runs on the stock node:20-alpine image.
//
// Login is handled by Cloudflare Access in front of this server. Every request
// carries a signed token (Cf-Access-Jwt-Assertion), which is verified here
// against the team's public keys; the email inside it identifies the user.
//
// Environment:
//   CF_TEAM_DOMAIN   e.g. "yourteam.cloudflareaccess.com"   (required)
//   CF_ACCESS_AUD    the Access application's "Application Audience (AUD) Tag" (required)
//   ALLOWED_EMAILS   optional comma-separated list; anyone else gets 403
//   LEARNED_STREAK   correct answers in a row to count a word as learned (default 2)
//   PORT             default 8787
//   DATA_DIR         where progress.json lives (default ./data)
//   DEV_USER_EMAIL   local testing only: skip Cloudflare and act as this user
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8787;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "progress.json");
const INDEX_FILE = path.join(__dirname, "index.html");
const ICON_FILE = path.join(__dirname, "apple-touch-icon.png");
const TEAM = (process.env.CF_TEAM_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
const AUD = process.env.CF_ACCESS_AUD || "";
const DEV_USER = process.env.DEV_USER_EMAIL || "";
const STREAK = Number(process.env.LEARNED_STREAK) || 2;
const ALLOWED = (process.env.ALLOWED_EMAILS || "")
  .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

// ---------- Progress storage ----------
// { "<email>": { "<word>": { streak, correct, wrong, learned, at } } }

let db = {};
function load() {
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch (e) { if (e.code !== "ENOENT") throw e; db = {}; }
}
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}

// Same rule as the page: STREAK correct in a row = learned; a miss resets it.
function applyAnswer(rec, correct) {
  rec = rec || { streak: 0, correct: 0, wrong: 0, learned: false };
  if (correct) {
    rec.correct++;
    rec.streak++;
    if (rec.streak >= STREAK) rec.learned = true;
  } else {
    rec.wrong++;
    rec.streak = 0;
    rec.learned = false;
  }
  rec.at = Date.now();
  return rec;
}

// ---------- Cloudflare Access token check ----------

let keys = {};
let keysFetchedAt = 0;
async function getKey(kid) {
  if (!keys[kid] && Date.now() - keysFetchedAt > 60 * 1000) {
    const res = await fetch(`https://${TEAM}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`certs fetch failed: ${res.status}`);
    const body = await res.json();
    keys = {};
    for (const jwk of body.keys || []) keys[jwk.kid] = crypto.createPublicKey({ key: jwk, format: "jwk" });
    keysFetchedAt = Date.now();
  }
  return keys[kid];
}

function b64json(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

// Returns the verified email, or throws.
async function verifyAccessToken(token, opts = {}) {
  const team = opts.team || TEAM;
  const aud = opts.aud || AUD;
  const keyFor = opts.getKey || getKey;
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const header = b64json(parts[0]);
  const payload = b64json(parts[1]);
  if (header.alg !== "RS256") throw new Error("unexpected alg");
  const key = await keyFor(header.kid);
  if (!key) throw new Error("unknown key");
  const ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]),
    key, Buffer.from(parts[2], "base64url"));
  if (!ok) throw new Error("bad signature");
  const now = Date.now() / 1000;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new Error("wrong audience");
  if (payload.iss !== `https://${team}`) throw new Error("wrong issuer");
  if (typeof payload.exp !== "number" || payload.exp < now - 60) throw new Error("expired");
  if (payload.nbf && payload.nbf > now + 60) throw new Error("not yet valid");
  if (!payload.email) throw new Error("no email");
  return String(payload.email).toLowerCase();
}

function tokenFrom(req) {
  const h = req.headers["cf-access-jwt-assertion"];
  if (h) return h;
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.cookie || "");
  return m ? m[1] : "";
}

async function userFor(req) {
  const email = DEV_USER ? DEV_USER.toLowerCase() : await verifyAccessToken(tokenFrom(req));
  if (ALLOWED.length && !ALLOWED.includes(email)) {
    const err = new Error("not allowed"); err.status = 403; throw err;
  }
  return email;
}

// ---------- HTTP ----------

function send(res, status, body, type) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": type || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 200 * 1024) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(Object.assign(new Error("bad json"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

const isWord = (w) => typeof w === "string" && w.length > 0 && w.length <= 64;

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/healthz") return send(res, 200, { ok: true });

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    return send(res, 200, fs.readFileSync(INDEX_FILE, "utf8"), "text/html; charset=utf-8");
  }

  // Home-screen icon. iOS also asks for these root paths when a page has no link tag.
  if (req.method === "GET" && ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/favicon.ico"].includes(url.pathname)) {
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
    return res.end(fs.readFileSync(ICON_FILE));
  }

  if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });

  let email;
  try { email = await userFor(req); }
  catch (e) { return send(res, e.status || 401, { error: "Sign in again: " + e.message }); }
  const mine = db[email] || (db[email] = {});

  // Everything this user has answered, plus the learned rule.
  if (req.method === "GET" && url.pathname === "/api/progress") {
    return send(res, 200, { email, streak: STREAK, words: mine });
  }

  // A batch of answers: [{ word, correct }]. The page queues answers while
  // offline and sends them together, so one endpoint covers both cases.
  if (req.method === "POST" && url.pathname === "/api/answers") {
    const body = await readJson(req);
    const answers = Array.isArray(body.answers) ? body.answers.slice(0, 1000) : [];
    const updated = {};
    for (const a of answers) {
      if (!isWord(a && a.word)) continue;
      updated[a.word] = mine[a.word] = applyAnswer(mine[a.word], !!a.correct);
    }
    save();
    return send(res, 200, { words: updated });
  }

  // Forget progress for some words (one day) or, with no list, all of them.
  if (req.method === "POST" && url.pathname === "/api/reset") {
    const body = await readJson(req);
    if (Array.isArray(body.words)) body.words.filter(isWord).forEach((w) => delete mine[w]);
    else db[email] = {};
    save();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: "not found" });
}

if (require.main === module) {
  if (!DEV_USER && (!TEAM || !AUD)) {
    console.error("Set CF_TEAM_DOMAIN and CF_ACCESS_AUD (or DEV_USER_EMAIL for local testing).");
    process.exit(1);
  }
  if (DEV_USER) console.warn(`DEV_USER_EMAIL is set: everyone is treated as ${DEV_USER}. Never use this in production.`);
  load();
  http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "server error" });
    });
  }).listen(PORT, () => console.log(`Vocab flashcards on port ${PORT}, learned after ${STREAK} in a row`));
}

module.exports = { verifyAccessToken, applyAnswer };
