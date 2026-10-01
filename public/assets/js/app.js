// PWR Props entry: shell wiring and a small query-string router.
// Routes live on "/" so the Worker's asset serving is unchanged, and the
// original share links (/?pitcher=...&line=...) keep resolving to the pitcher.
import { mountIcons, icon } from "./icons.js";
import { api } from "./api.js";
import { ago } from "./format.js";

const views = {
  home: () => import("./views/home.js"),
  board: () => import("./views/board.js"),
  matchups: () => import("./views/matchups.js"),
  detail: () => import("./views/detail.js"),
};

const app = document.getElementById("app");
const main = document.getElementById("main");
let cleanup = null;
let renderToken = 0;

export function routeOf(url = new URL(window.location.href)) {
  const p = url.searchParams;
  if (p.has("pitcher")) return { name: "detail", params: p };
  const v = p.get("view");
  return { name: views[v] ? v : "home", params: p };
}

/** Navigate within the app. Scroll position of the page being left is kept in history. */
export function navigate(href, { replace = false } = {}) {
  const url = new URL(href, window.location.origin);
  if (url.origin !== window.location.origin) { window.location.href = href; return; }
  history.replaceState({ ...(history.state || {}), scrollY: window.scrollY }, "");
  if (replace) history.replaceState({ scrollY: 0 }, "", url);
  else history.pushState({ scrollY: 0 }, "", url);
  render({ restoreScroll: false });
}

/** Update the URL for in-view state (filters, sample, tab) without re-rendering. */
export function setQuery(mutate) {
  const url = new URL(window.location.href);
  mutate(url.searchParams);
  history.replaceState({ ...(history.state || {}), scrollY: window.scrollY }, "", url);
  if (routeOf(url).name === "board") sessionStorage.setItem("pwr:lastBoard", url.search);
}

export function boardHref() {
  let s = null;
  try { s = sessionStorage.getItem("pwr:lastBoard"); } catch {}
  return `/${s || "?view=board"}`;
}

async function render({ restoreScroll }) {
  const token = ++renderToken;
  const route = routeOf();
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }

  document.querySelectorAll("[data-nav]").forEach((a) => {
    const active = a.dataset.nav === route.name || (route.name === "detail" && a.dataset.nav === "board");
    if (active) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  // Board links carry the last filters so "back to the board" lands where you were.
  document.querySelectorAll('[data-nav="board"]').forEach((a) => a.setAttribute("href", boardHref()));

  const mod = await views[route.name]();
  if (token !== renderToken) return;

  const swap = () => {
    main.innerHTML = "";
    cleanup = mod.render(main, route.params, { navigate, setQuery, boardHref }) || null;
    const y = restoreScroll ? history.state?.scrollY || 0 : 0;
    window.scrollTo(0, y);
  };
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (document.startViewTransition && !reduce && main.childElementCount) document.startViewTransition(swap);
  else swap();
}

// Same-origin links marked data-link, and plain in-app anchors, use the router.
document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest("a[href]");
  if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
  const url = new URL(a.href, window.location.origin);
  if (url.origin !== window.location.origin || url.pathname !== "/") return;
  e.preventDefault();
  navigate(url.pathname + url.search);
});
window.addEventListener("popstate", () => render({ restoreScroll: true }));
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

// ---------- Shell ----------
function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    el.outerHTML = icon(el.dataset.icon);
  });
}

function setupRail() {
  const btn = document.getElementById("rail-toggle");
  const mq = window.matchMedia("(max-width: 1279px)");
  let pref = null;
  try { pref = localStorage.getItem("pwr:rail"); } catch {}
  const apply = () => {
    const rail = pref != null ? pref === "true" : mq.matches;
    app.dataset.rail = String(rail);
    btn.setAttribute("aria-expanded", String(!rail));
    btn.setAttribute("aria-label", rail ? "Expand sidebar" : "Collapse sidebar");
    btn.innerHTML = icon("sidebar-simple");
  };
  btn.addEventListener("click", () => {
    pref = String(app.dataset.rail !== "true");
    try { localStorage.setItem("pwr:rail", pref); } catch {}
    apply();
  });
  mq.addEventListener("change", () => { pref = null; apply(); });
  apply();
}

function setupAccountMenu() {
  const btn = document.getElementById("account-btn");
  const menu = document.getElementById("account-menu");
  const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute("aria-expanded", String(!menu.hidden));
  });
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
}

async function loadUser() {
  try {
    const me = await api.me();
    const name = me.username || "Member";
    ["side-username", "menu-username"].forEach((id) => { document.getElementById(id).textContent = name; });
    ["side-avatar", "top-avatar"].forEach((id) => {
      const el = document.getElementById(id);
      if (me.avatar_url) el.innerHTML = `<img src="${me.avatar_url}" width="34" height="34" alt="">`;
      else el.textContent = name.charAt(0).toUpperCase();
    });
  } catch {}
}

export async function refreshFreshness() {
  try {
    const odds = await api.odds();
    // A "line" is one pitcher, market and number with its Over and Under together,
    // the same unit the board lists.
    const n = new Set((odds.props || []).map((p) => `${p.event_id}|${p.player_name}|${p.market_type}|${Number(p.line)}`)).size;
    const books = new Set((odds.props || []).flatMap((p) => p.books.map((b) => b.sportsbook)));
    const text = odds.updated_at
      ? `<b>Odds updated ${ago(odds.updated_at)}</b><br>${n} ${n === 1 ? "line" : "lines"} from ${books.size} ${books.size === 1 ? "book" : "books"}`
      : "No odds loaded yet";
    document.querySelectorAll("#side-fresh .fresh-text, #menu-fresh .fresh-text").forEach((el) => { el.innerHTML = text; });
    const count = document.getElementById("nav-props-count");
    if (count) count.textContent = n ? String(n) : "";
  } catch {
    document.querySelectorAll("#side-fresh .fresh-text").forEach((el) => { el.textContent = "Odds unavailable"; });
  }
}

// Scroll cues for anything that scrolls sideways (wide tables, the section index
// strip): data-more is set while content continues past the right edge.
const cueRO = new ResizeObserver((entries) => entries.forEach((e) => (e.target.isConnected ? updateCue(e.target) : cueRO.unobserve(e.target))));
function updateCue(el) {
  const more = el.scrollWidth - el.clientWidth - el.scrollLeft > 2;
  if (more) el.setAttribute("data-more", "end"); else el.removeAttribute("data-more");
}
function wireCues() {
  main.querySelectorAll(".table-scroll, .toc").forEach((el) => {
    if (el.dataset.cue) { updateCue(el); return; }
    el.dataset.cue = "1";
    el.addEventListener("scroll", () => updateCue(el), { passive: true });
    cueRO.observe(el);
    updateCue(el);
  });
}
let cueQueued = false;
new MutationObserver(() => {
  if (cueQueued) return;
  cueQueued = true;
  requestAnimationFrame(() => { cueQueued = false; wireCues(); });
}).observe(main, { childList: true, subtree: true });

mountIcons();
hydrateIcons();
setupRail();
setupAccountMenu();
loadUser();
refreshFreshness();
setInterval(refreshFreshness, 60_000);
render({ restoreScroll: true });

export { hydrateIcons };
