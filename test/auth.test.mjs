// Tests for login and access: the Discord OAuth state check (valid, missing,
// wrong, expired, forged, replayed) and Premium entitlement revalidation
// (Premium user, role removed, expired entitlement cache, Discord failure,
// invalid session). Everything runs through the Worker's own fetch handler with
// Discord stubbed; nothing real is called and the secret below is test-only.
// Run with: node --test test/auth.test.mjs
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../src/index.js";
import {
  checkOAuthState,
  createOAuthState,
  createSessionCookie,
  resetEntitlementLookups,
  ENTITLEMENT_TTL,
  ENTITLEMENT_GRACE,
  OAUTH_STATE_TTL,
} from "../src/auth.js";

const SECRET = "test-only-session-secret";
const env = {
  SESSION_SECRET: SECRET,
  DISCORD_CLIENT_ID: "client-1",
  DISCORD_CLIENT_SECRET: "client-secret-1",
  DISCORD_GUILD_ID: "guild-1",
  DISCORD_PREMIUM_ROLE_ID: "role-premium",
  DISCORD_BOT_TOKEN: "bot-token-1",
  ASSETS: { fetch: async () => new Response("<!doctype html><title>PWR Props</title>app", { headers: { "content-type": "text/html" } }) },
};
const ORIGIN = "https://props.example";

// --- Discord stub and clock ---------------------------------------------------
let member; // what the guild member lookup answers: { roles }, 404, or "fail"
let calls;
const realFetch = globalThis.fetch;
const realNow = Date.now;
let now;

beforeEach(() => {
  resetEntitlementLookups();
  member = { roles: ["role-premium"] };
  calls = { token: 0, me: 0, member: 0 };
  now = realNow.call(Date);
  Date.now = () => now;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/oauth2/token")) {
      calls.token++;
      return new Response(JSON.stringify({ access_token: "user-token" }), { status: 200 });
    }
    if (url.endsWith("/users/@me")) {
      calls.me++;
      return new Response(JSON.stringify({ id: "u1", username: "tester", avatar: null }), { status: 200 });
    }
    if (url.includes("/guilds/guild-1/members/u1")) {
      calls.member++;
      if (member === 404) return new Response("{}", { status: 404 });
      if (member === "fail") return new Response("{}", { status: 503 });
      return new Response(JSON.stringify(member), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
});

const go = (path, cookie) => worker.fetch(new Request(ORIGIN + path, { headers: cookie ? { Cookie: cookie } : {} }), env, { waitUntil() {} });
const setCookies = (res) => res.headers.getSetCookie();
const cookieValue = (res, name) => {
  const c = setCookies(res).find((s) => s.startsWith(`${name}=`));
  return c ? c.split(";")[0].slice(name.length + 1) : null;
};
const attr = (res, name, key) => {
  const c = setCookies(res).find((s) => s.startsWith(`${name}=`));
  const m = c && c.match(new RegExp(`${key}=([^;]+)`));
  return m ? m[1] : null;
};

async function startLogin() {
  const res = await go("/login");
  const state = new URL(res.headers.get("location")).searchParams.get("state");
  return { res, state, cookie: `pwr_oauth_state=${cookieValue(res, "pwr_oauth_state")}` };
}

// A session minted the way an older deploy did: no entitlement fields.
function legacySession(exp) {
  const payload = Buffer.from(JSON.stringify({ id: "u1", username: "tester", avatar: null, exp })).toString("base64url");
  return `pwr_session=${payload}.${createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
}
const sessionOf = async () => (await createSessionCookie("u1", "tester", null, SECRET)).split(";")[0];

// --- OAuth state ----------------------------------------------------------------

test("login sends Discord a random state and keeps it in a short-lived, callback-only cookie", async () => {
  const a = await startLogin();
  const b = await startLogin();
  assert.equal(a.res.status, 302);
  assert.match(a.state, /^[A-Za-z0-9_-]{43}$/); // 32 random bytes
  assert.notEqual(a.state, b.state);
  assert.ok(cookieValue(a.res, "pwr_oauth_state").startsWith(`${a.state}.`));
  const raw = setCookies(a.res).find((s) => s.startsWith("pwr_oauth_state="));
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/auth/callback", `Max-Age=${OAUTH_STATE_TTL}`]) assert.ok(raw.includes(flag), flag);
  assert.equal(a.res.headers.get("cache-control"), "no-store");
});

test("valid state: login completes, session issued, state cookie cleared", async () => {
  const { state, cookie } = await startLogin();
  const res = await go(`/auth/callback?code=abc&state=${state}`, cookie);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/");
  assert.ok(cookieValue(res, "pwr_session"));
  assert.equal(attr(res, "pwr_oauth_state", "Max-Age"), "0");
  assert.deepEqual([calls.token, calls.member], [1, 1]);
});

test("missing state is refused before the code is used", async () => {
  const { cookie } = await startLogin();
  for (const [path, c] of [["/auth/callback?code=abc", cookie], [`/auth/callback?code=abc&state=x`, undefined]]) {
    const res = await go(path, c);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Login link expired/);
    assert.equal(attr(res, "pwr_oauth_state", "Max-Age"), "0");
    assert.equal(cookieValue(res, "pwr_session"), null);
  }
  assert.equal(calls.token, 0);
});

test("wrong state is refused", async () => {
  const { cookie } = await startLogin();
  const other = await startLogin();
  const res = await go(`/auth/callback?code=abc&state=${other.state}`, cookie);
  assert.equal(res.status, 400);
  assert.equal(calls.token, 0);
});

test("expired state is refused", async () => {
  const { state, cookie } = await startLogin();
  now += (OAUTH_STATE_TTL + 1) * 1000;
  const res = await go(`/auth/callback?code=abc&state=${state}`, cookie);
  assert.equal(res.status, 400);
  assert.equal(calls.token, 0);
});

test("a forged or tampered state cookie is refused", async () => {
  const { state, cookie } = await startLogin();
  const [s, exp, sig] = cookie.split("=")[1].split(".");
  const forged = [`pwr_oauth_state=attacker.${exp}.${sig}`, `pwr_oauth_state=${s}.${Number(exp) + 9999}.${sig}`, `pwr_oauth_state=${s}.${exp}`, "pwr_oauth_state=junk"];
  for (const c of forged) {
    const res = await go(`/auth/callback?code=abc&state=${c.includes("attacker") ? "attacker" : state}`, c);
    assert.equal(res.status, 400, c);
  }
  assert.equal(calls.token, 0);
});

test("a replayed callback is refused once the state cookie has been cleared", async () => {
  const { state, cookie } = await startLogin();
  const first = await go(`/auth/callback?code=abc&state=${state}`, cookie);
  assert.equal(first.status, 302);
  assert.equal(attr(first, "pwr_oauth_state", "Max-Age"), "0"); // the browser drops it
  const replay = await go(`/auth/callback?code=abc&state=${state}`);
  assert.equal(replay.status, 400);
  assert.equal(calls.token, 1);
});

test("the state value never reaches the logs", async () => {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(a.join(" "));
  try {
    const { state, cookie } = await startLogin();
    await go(`/auth/callback?code=abc&state=${state}x`, cookie);
    await go(`/auth/callback?code=abc&state=${state}`);
    await go(`/auth/callback?code=abc&state=${state}`, cookie);
    assert.ok(lines.length >= 2);
    assert.ok(lines.every((l) => !l.includes(state)));
  } finally {
    Object.assign(console, saved);
  }
});

test("checkOAuthState names each refusal", async () => {
  const t = realNow.call(Date);
  const { state, cookie } = await createOAuthState(SECRET, t);
  const header = cookie.split(";")[0];
  assert.equal(await checkOAuthState(header, state, SECRET, t), "ok");
  assert.equal(await checkOAuthState(header, null, SECRET, t), "missing");
  assert.equal(await checkOAuthState("", state, SECRET, t), "missing");
  assert.equal(await checkOAuthState(header, `${state}A`, SECRET, t), "mismatch");
  assert.equal(await checkOAuthState(header, state, "another-secret", t), "invalid");
  assert.equal(await checkOAuthState(header, state, SECRET, t + (OAUTH_STATE_TTL + 1) * 1000), "expired");
});

// --- Premium entitlement --------------------------------------------------------

test("Premium user inside the entitlement window: served with no Discord call", async () => {
  const session = await sessionOf();
  const res = await go("/api/me", session);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).username, "tester");
  assert.equal(calls.member, 0);
  assert.equal(cookieValue(res, "pwr_session"), null);
});

test("expired entitlement cache: one Discord recheck, cookie re-signed with the same expiry", async () => {
  const session = await sessionOf();
  now += (ENTITLEMENT_TTL + 60) * 1000;
  const res = await go("/api/me", session);
  assert.equal(res.status, 200);
  assert.equal(calls.member, 1);
  const renewed = `pwr_session=${cookieValue(res, "pwr_session")}`;
  // Same expiry: Max-Age shrank by exactly the time elapsed since login.
  assert.equal(Number(attr(res, "pwr_session", "Max-Age")), 30 * 24 * 3600 - (ENTITLEMENT_TTL + 60));
  assert.equal(res.headers.get("cache-control"), "private, no-store"); // a session never sits in a shared cache
  const again = await go("/", renewed);
  assert.equal(again.status, 200);
  assert.equal(calls.member, 1); // the renewed answer is trusted for another window
});

test("many requests at once after the window: one Discord lookup", async () => {
  const session = await sessionOf();
  now += (ENTITLEMENT_TTL + 1) * 1000;
  const all = await Promise.all(Array.from({ length: 12 }, () => go("/api/me", session)));
  assert.ok(all.every((r) => r.status === 200));
  assert.equal(calls.member, 1);
});

test("role removed: API 403 premium_required, page shows Premium required, answer cached", async () => {
  const session = await sessionOf();
  member = { roles: ["someone-else"] };
  now += (ENTITLEMENT_TTL + 1) * 1000;
  const api = await go("/api/me", session);
  assert.equal(api.status, 403);
  assert.deepEqual(await api.json(), { error: "premium_required" });
  const denied = `pwr_session=${cookieValue(api, "pwr_session")}`;
  const page = await go("/", denied);
  assert.equal(page.status, 403);
  assert.match(await page.text(), /Premium access required/);
  assert.equal(calls.member, 1); // the "no" is cached like a "yes"
  // Role restored: the next recheck lets them back in without logging in again.
  member = { roles: ["role-premium"] };
  now += (ENTITLEMENT_TTL + 1) * 1000;
  resetEntitlementLookups();
  assert.equal((await go("/api/me", denied)).status, 200);
});

test("left the server (Discord 404): access ends at the next recheck", async () => {
  const session = await sessionOf();
  member = 404;
  now += (ENTITLEMENT_TTL + 1) * 1000;
  const res = await go("/api/odds", session);
  assert.equal(res.status, 403);
});

test("Discord failure: a recently confirmed member keeps access inside the grace window", async () => {
  const session = await sessionOf();
  member = "fail";
  now += (ENTITLEMENT_TTL + 1) * 1000;
  const res = await go("/api/me", session);
  assert.equal(res.status, 200);
  assert.equal(cookieValue(res, "pwr_session"), null); // nothing confirmed, nothing re-signed
});

test("Discord failure past the grace window: 503, session kept, retried later", async () => {
  const session = await sessionOf();
  member = "fail";
  now += (ENTITLEMENT_GRACE + 1) * 1000;
  const api = await go("/api/me", session);
  assert.equal(api.status, 503);
  assert.deepEqual(await api.json(), { error: "entitlement_unavailable" });
  assert.equal(api.headers.get("retry-after"), "60");
  const page = await go("/", session);
  assert.equal(page.status, 503);
  assert.match(await page.text(), /Can't confirm Premium right now/);
  assert.equal(calls.member, 1); // one lookup per minute per isolate during an outage
  member = { roles: ["role-premium"] };
  now += 61 * 1000;
  assert.equal((await go("/api/me", session)).status, 200);
});

test("session from before entitlement tracking: rechecked on first use, no grace without a confirmed time", async () => {
  const exp = Math.floor(now / 1000) + 3600;
  const res = await go("/api/me", legacySession(exp));
  assert.equal(res.status, 200);
  assert.equal(calls.member, 1);
  assert.ok(cookieValue(res, "pwr_session"));
  resetEntitlementLookups();
  member = "fail";
  assert.equal((await go("/api/me", legacySession(exp))).status, 503);
});

test("invalid session: tampered, expired, or wrong secret gets the login, never Discord", async () => {
  const good = await sessionOf();
  const tampered = good.slice(0, -2) + (good.endsWith("AA") ? "BB" : "AA");
  const expired = legacySession(Math.floor(now / 1000) - 10);
  for (const c of [tampered, expired, "pwr_session=garbage", "xpwr_session=" + good.split("=")[1]]) {
    const api = await go("/api/me", c);
    assert.equal(api.status, 401, c);
    const page = await go("/board", c);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Log in to PWR Props/);
  }
  assert.equal(calls.member, 0);
});

test("logout clears the session", async () => {
  const res = await go("/logout", await sessionOf());
  assert.equal(res.status, 302);
  assert.equal(attr(res, "pwr_session", "Max-Age"), "0");
});
