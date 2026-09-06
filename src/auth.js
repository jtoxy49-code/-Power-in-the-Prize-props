const DISCORD_API = "https://discord.com/api/v10";

/**
 * Builds the URL that sends a user to Discord to log in and
 * authorize this app.
 */
export function getDiscordAuthUrl(clientId, redirectUri) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify",
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

export async function createSessionCookie(discordUserId, secret, ttlSeconds = 30 * 24 * 60 * 60) {
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${discordUserId}.${expiry}`;
  const signature = await hmacSign(payload, secret);
  const token = `${payload}.${signature}`;
  return `pwr_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttlSeconds}`;
}

export async function verifySessionCookie(cookieHeader, secret) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/pwr_session=([^;]+)/);
  if (!match) return null;

  const token = match[1];
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [discordUserId, expiry, signature] = parts;

  const expectedSig = await hmacSign(`${discordUserId}.${expiry}`, secret);
  if (expectedSig !== signature) return null; // tampered or wrong secret
  if (Number(expiry) < Math.floor(Date.now() / 1000)) return null; // expired

  return discordUserId;
}
