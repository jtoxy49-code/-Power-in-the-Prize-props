const DISCORD_API = "https://discord.com/api/v10";

/**
 * Builds the URL that sends a user to Discord to log in and
 * authorize this app. state is the one-time value from createOAuthState().
 */
export function getDiscordAuthUrl(clientId, redirectUri, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify",
    state,
  });
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

/**
 * Exchanges the one-time code Discord sends back for a real access
 * token, then uses that token to fetch the logged-in user's own
 * Discord identity (just their ID — that's all we need).
 */
export async function exchangeCodeForUser(code, clientId, clientSecret, redirectUri) {
  const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Discord token exchange failed: ${tokenRes.status}`);
  }
  const tokenData = await tokenRes.json();

  const userRes = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!userRes.ok) {
    throw new Error(`Discord user fetch failed: ${userRes.status}`);
  }
  return userRes.json(); // { id, username, ... }
}

/**
 * Uses the BOT token (server-side, never the user's own token) to
 * check whether a given Discord user holds the premium role in the
 * server. This requires the bot to already be a member of that
 * server with permission to view members.
 */
export async function hasPremiumRole(discordUserId, guildId, premiumRoleId, botToken) {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${discordUserId}`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (res.status === 404) return false; // not a member of the server at all
  if (!res.ok) {
    throw new Error(`Discord member lookup failed: ${res.status}`);
  }
  const member = await res.json();
  return (member.roles || []).includes(premiumRoleId);
}

// --- Signed session cookie helpers ---
// A session is just: base64url(discordId + "." + expiryTimestamp) + "." + HMAC signature.
// This lets us trust the cookie's contents without needing to store
// sessions anywhere (no KV lookups needed on every request).

async function hmacSign(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncode(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  return decodeURIComponent(escape(atob(padded)));
}

// Constant-time string comparison for signatures and state values.
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The value of one cookie by exact name (so "xpwr_session" never matches).
function readCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

// --- OAuth state (login CSRF protection) ---
// /login sends Discord a fresh random state and keeps the same value in a
// short-lived cookie, signed with SESSION_SECRET, that only /auth/callback
// receives. The callback accepts a login only when Discord hands back exactly
// that value before the cookie expires. Every callback response clears the
// cookie, so a state is good for one attempt. The value is never logged.

export const OAUTH_STATE_COOKIE = "pwr_oauth_state";
export const OAUTH_STATE_TTL = 10 * 60; // seconds allowed to finish logging in at Discord
const OAUTH_STATE_PATH = "/auth/callback";

export const clearOAuthStateCookie = `${OAUTH_STATE_COOKIE}=; Path=${OAUTH_STATE_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export async function createOAuthState(secret, nowMs = Date.now()) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const state = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const exp = Math.floor(nowMs / 1000) + OAUTH_STATE_TTL;
  const sig = await hmacSign(`oauth-state:${state}.${exp}`, secret);
  return {
    state,
    cookie: `${OAUTH_STATE_COOKIE}=${state}.${exp}.${sig}; Path=${OAUTH_STATE_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${OAUTH_STATE_TTL}`,
  };
}

/**
 * "ok", or why the callback must be refused: "missing" (no state cookie or no
 * state from Discord, which includes a replay after the cookie was cleared),
 * "invalid" (cookie not signed by us), "expired", or "mismatch".
 */
export async function checkOAuthState(cookieHeader, returnedState, secret, nowMs = Date.now()) {
  const token = readCookie(cookieHeader, OAUTH_STATE_COOKIE);
  if (!token || !returnedState) return "missing";
  const parts = token.split(".");
  if (parts.length !== 3 || !/^\d+$/.test(parts[1])) return "invalid";
  const [state, exp, sig] = parts;
  if (!timingSafeEqual(sig, await hmacSign(`oauth-state:${state}.${exp}`, secret))) return "invalid";
  if (Number(exp) <= Math.floor(nowMs / 1000)) return "expired";
  if (!timingSafeEqual(state, returnedState)) return "mismatch";
  return "ok";
}

// --- Session cookie ---
// The payload also records Premium entitlement: ent is when the Premium role
// was last confirmed with Discord (unix seconds) and prem is that answer.

const SESSION_TTL = 30 * 24 * 60 * 60;

async function signSession(payload, secret, nowS) {
  const payloadStr = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSign(payloadStr, secret);
  const token = `${payloadStr}.${signature}`;
  return `pwr_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, payload.exp - nowS)}`;
}

// Issued only after a confirmed Premium check, so it starts entitled.
export async function createSessionCookie(discordUserId, username, avatarHash, secret, ttlSeconds = SESSION_TTL) {
  const now = Math.floor(Date.now() / 1000);
  return signSession({ id: discordUserId, username, avatar: avatarHash, exp: now + ttlSeconds, ent: now, prem: true }, secret, now);
}

export async function verifySessionCookie(cookieHeader, secret) {
  const token = readCookie(cookieHeader, "pwr_session");
  if (!token) return null;

  const dotIdx = token.lastIndexOf(".");
  if (dotIdx === -1) return null;
  const payloadStr = token.slice(0, dotIdx);
  const signature = token.slice(dotIdx + 1);

  const expectedSig = await hmacSign(payloadStr, secret);
  if (!timingSafeEqual(expectedSig, signature)) return null; // tampered or wrong secret

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadStr));
  } catch (err) {
    return null;
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null; // expired

  // Sessions issued before entitlement tracking carry no ent/prem; they are
  // rechecked with Discord on their first request.
  return { id: payload.id, username: payload.username, avatar: payload.avatar, exp: payload.exp, ent: payload.ent, prem: payload.prem };
}

// --- Premium entitlement revalidation ---
// The session proves identity for 30 days, but Premium is a Discord role that
// can be removed at any time. Each gated request trusts the signed ent/prem
// answer while it is younger than ENTITLEMENT_TTL; after that the Worker asks
// Discord again and re-signs the cookie with the new answer (same identity,
// same expiry, so a session never outlives its original 30 days). Within one
// isolate a user's Discord lookup is shared for LOOKUP_REUSE_MS, so a page
// that fires many API calls at once, or a Discord outage, costs at most one
// lookup per user per minute there.

export const ENTITLEMENT_TTL = 15 * 60; // seconds a Premium answer is trusted
export const ENTITLEMENT_GRACE = 6 * 60 * 60; // Discord unreachable: how long a confirmed member keeps access
const LOOKUP_REUSE_MS = 60 * 1000;
const lookups = new Map(); // discord id -> { at, result: Promise<{ ok, premium, at }> }

function lookupPremium(id, env, nowMs) {
  const hit = lookups.get(id);
  if (hit && nowMs - hit.at < LOOKUP_REUSE_MS) return hit.result;
  if (lookups.size > 1000) {
    for (const [key, entry] of lookups) if (nowMs - entry.at >= LOOKUP_REUSE_MS) lookups.delete(key);
  }
  const at = Math.floor(nowMs / 1000);
  const result = hasPremiumRole(id, env.DISCORD_GUILD_ID, env.DISCORD_PREMIUM_ROLE_ID, env.DISCORD_BOT_TOKEN).then(
    (premium) => ({ ok: true, premium, at }),
    (err) => {
      console.warn(`Premium recheck failed, Discord unavailable: ${err.message}`);
      return { ok: false };
    }
  );
  lookups.set(id, { at: nowMs, result });
  return result;
}

// Test hook: forget every shared lookup.
export function resetEntitlementLookups() {
  lookups.clear();
}

/**
 * Whether a valid session may use the app right now: { allow, reason, cookie }.
 * reason is "premium_required" (Discord says the user lacks the Premium role)
 * or "entitlement_unavailable" (Discord could not be asked and the last
 * confirmed Premium is older than ENTITLEMENT_GRACE). cookie, when present, is
 * the re-signed session carrying the new answer.
 */
export async function checkEntitlement(session, env, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const checkedAt = Number.isFinite(session.ent) ? session.ent : null;
  const known = typeof session.prem === "boolean";
  if (known && checkedAt !== null && now - checkedAt < ENTITLEMENT_TTL) {
    return session.prem ? { allow: true } : { allow: false, reason: "premium_required" };
  }

  const answer = await lookupPremium(session.id, env, nowMs);
  if (answer.ok) {
    const payload = { id: session.id, username: session.username, avatar: session.avatar, exp: session.exp, ent: answer.at, prem: answer.premium };
    const cookie = await signSession(payload, env.SESSION_SECRET, now);
    return answer.premium ? { allow: true, cookie } : { allow: false, reason: "premium_required", cookie };
  }

  // Discord did not answer: the last known answer stands only for a member
  // confirmed Premium within the grace window. Everyone else waits.
  if (session.prem === false) return { allow: false, reason: "premium_required" };
  if (session.prem === true && checkedAt !== null && now - checkedAt < ENTITLEMENT_GRACE) return { allow: true };
  return { allow: false, reason: "entitlement_unavailable" };
}
