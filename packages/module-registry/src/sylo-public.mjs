/**
 * sylo-public.mjs: public information pages for Sylo under /explore (accounts: Entity, Local, KYC, Game; Access; Public; Pricing).
 * Informational only: no user data is ever shown. Every action button goes to /login?next=<app path>, so anything that
 * changes or reads data needs an account. Text is written for the public site (not the author's notes in sylo-docs-data.mjs).
 * Pricing shows the live AZN price from GET /api/sylo/credit/pricing (public, numbers only) and falls back to a sign-in link.
 */
import { CONTENT } from "./landing-content.mjs";
import { getModule } from "./index.mjs";
import { chrome, crumbsHtml, crumbsLd, publisher, origin, DOCS_MODULE } from "./sylo-docs.mjs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const login = (to) => to; // the app sends a signed-out visitor to /login for any /vault path

export const PUBLIC_PAGES = [
  { slug: "entity", group: "Accounts", title: "Entity", desc: "Entities hold everything that belongs to one identity: its accounts, mail, 2FA codes, backups and shares.",
    points: ["Create an entity and group it with categories, tags and a status.", "Open one page per entity: details, linked accounts, mail inbox, 2FA and backup.", "Share an entity with someone else, see who has access and take it back at any time.", "Banned, trashed and activity views keep a clear record of what changed."],
    actions: [["Create an entity", "/vault/account/entity/new"], ["Open my entities", "/vault/account/entity"]] },
  { slug: "local", group: "Accounts", title: "Local", desc: "Local accounts are the logins you keep yourself, sorted into your own categories.",
    points: ["Add a login with its category and notes; secrets stay hidden until you reveal them.", "Make your own categories and remove them when you no longer need them.", "Keep exchange accounts here too and manage them from one place.", "Share a single account or a selection, and review every share later."],
    actions: [["Add a local account", "/vault/account/local/new"], ["Open my local accounts", "/vault/account/local"]] },
  { slug: "kyc", group: "Accounts", title: "KYC", desc: "KYC entries keep verification details together so you can find them when a service asks.",
    points: ["Store each verification record on its own page with its status and dates.", "Sensitive values are masked and shown only when you ask.", "See which KYC entries are enrolled with a project and which still need work.", "Share or remove access whenever you choose."],
    actions: [["Add a KYC entry", "/vault/account/kyc/new"], ["Open my KYC entries", "/vault/account/kyc"]] },
  { slug: "game", group: "Accounts", title: "Game", desc: "Game entries track what you put into a game account and what you get back.",
    points: ["Keep each game account on its own page with its balance, dates and notes.", "Track amounts in and out and see the return (ROI) at a glance.", "Search and filter the list, then open one entry for the full details.", "Share or delete an entry from its page."],
    actions: [["Add a game entry", "/vault/account/game/new"], ["Open my game entries", "/vault/account/game"]] },
  { slug: "access", group: "More", title: "Access", desc: "Access is how you give other people a view of an entity or account, and how you take it back.",
    points: ["Share an entity or account with a person; you decide what they can see.", "Manage shares: see everyone who has access and remove them in one tap.", "Things shared with you appear in their own list.", "Nothing is shared unless you share it."],
    actions: [["Open my access list", "/vault/access/entity"], ["See what is shared with me", "/vault/shared"]] },
  { slug: "public", group: "More", title: "Public", desc: "What is public on Sylo, and what never is.",
    points: ["Public: the landing page, About, Docs and these information pages.", "Never public: your entities, accounts, mail, codes, KYC or game data.", "You need an account for any action: creating, viewing, sharing or buying.", "Pages you share go only to the people you pick."],
    actions: [["Sign in", "/vault"]] },
  { slug: "pricing", group: "More", title: "Pricing", desc: "Sylo is paid with AZN credit. See the current price and the minimum order.",
    points: ["Credit is bought in AZN at the price below, in USD or BDT.", "You send payment, then an admin approves the order and the AZN is added to your balance.", "Use the credit for Sylo services; usage is listed on your account.", "The price can change; the figure here is always the current one."],
    actions: [["Buy credit", "/vault/credit"]], pricing: true },
];
export const publicPaths = () => ["/explore", ...PUBLIC_PAGES.map((p) => `/explore/${p.slug}`)];
export const findPublicPage = (pathname) => {
  const p = String(pathname).replace(/\/+$/, "") || "/";
  if (p === "/explore") return { slug: "", index: true };
  return PUBLIC_PAGES.find((x) => p === `/explore/${x.slug}`) || null;
};
export const publicSitemapUrls = (opts = {}) => publicPaths().map((p) => `${origin(opts.origin)}${p}`);

function side(cur) {
  const grp = (g) => PUBLIC_PAGES.filter((p) => p.group === g).map((p) => `<li><a href="/explore/${p.slug}"${cur === p.slug ? ' aria-current="page"' : ""}>${esc(p.title)}</a></li>`).join("");
  return `<aside class="dx-side" aria-label="Sylo public pages"><p class="dx-eyebrow"><a href="/explore" style="text-decoration:none">Explore Sylo</a></p>
<details open><summary>Accounts</summary><ul>${grp("Accounts")}</ul></details><ul>${grp("More")}</ul>
<ul><li><a href="/docs">Docs</a></li><li><a href="/about">About</a></li></ul></aside>`;
}

const PRICE_JS = `<script>(function(){var el=document.getElementById("px");if(!el)return;fetch("/api/sylo/credit/pricing",{headers:{accept:"application/json"}}).then(function(r){return r.ok?r.json():Promise.reject()}).then(function(p){el.innerHTML="<strong>1 AZN = $"+p.priceUsd+" or Tk "+p.priceBdt+"</strong><br>Minimum order: "+p.minAzn+" AZN"}).catch(function(){el.textContent="Live price unavailable right now. Sign in to see it."})})()</script>`;

export function publicDocument(page, opts = {}) {
  const c = { id: DOCS_MODULE, label: getModule(DOCS_MODULE).label, ...CONTENT[DOCS_MODULE] };
  const base = origin(opts.origin), L = c.label;
  const crumbs = [[L, "/"], ["Explore", "/explore"]];
  if (page.index) {
    const title = `Explore ${L}: accounts, access and pricing`;
    const description = `${L} public pages: Entity, Local, KYC and Game accounts, Access, what is public and Pricing. Any action needs a sign-in.`;
    const body = `${crumbsHtml([[L, "/"], ["Explore", "/explore"]])}<p class="dx-eyebrow">Explore</p><h1>Explore ${esc(L)}</h1><p class="dx-lead">${esc(description)}</p>
<ul class="dx-grid">${PUBLIC_PAGES.map((p) => `<li><h3><a href="/explore/${p.slug}">${esc(p.title)}</a></h3><p>${esc(p.desc)}</p></li>`).join("")}</ul>`;
    const jsonLd = { "@context": "https://schema.org", "@graph": [{ "@type": "CollectionPage", url: `${base}/explore`, name: title, description, isPartOf: { "@type": "WebSite", name: L, url: `${base}/` }, publisher }, crumbsLd(base, crumbs)] };
    return chrome(c, { base, title, description, canonical: `${base}/explore`, jsonLd }, body, {}).replace(/<aside class="dx-side"[\s\S]*?<\/aside>/, side(""));
  }
  const title = `${page.title} | ${L}`;
  const cr = [...crumbs, [page.title, `/explore/${page.slug}`]];
  const body = `${crumbsHtml(cr)}<p class="dx-eyebrow">${esc(page.group)}</p><h1>${esc(page.title)}</h1><p class="dx-lead">${esc(page.desc)}</p>
${page.pricing ? `<p class="dx-items" style="padding:14px 18px;background:var(--surface);border-left:3px solid var(--accent);border-radius:6px;list-style:none" id="px">Loading price…</p>` : ""}
<ul class="dx-items">${page.points.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
<p>${page.actions.map(([t, to]) => `<a href="${login(to)}" rel="nofollow" style="display:inline-block;margin:0 10px 10px 0;padding:12px 18px;border-radius:10px;background:var(--accent);color:var(--ink);font-weight:600;text-decoration:none">${esc(t)}</a>`).join("")}</p>
<p style="color:var(--muted)">Every action above asks you to sign in first.</p>${page.pricing ? PRICE_JS : ""}`;
  const jsonLd = { "@context": "https://schema.org", "@graph": [{ "@type": "WebPage", url: `${base}/explore/${page.slug}`, name: title, description: page.desc, isPartOf: { "@type": "WebSite", name: L, url: `${base}/` }, publisher }, crumbsLd(base, cr)] };
  return chrome(c, { base, title, description: page.desc, canonical: `${base}/explore/${page.slug}`, jsonLd }, body, {}).replace(/<aside class="dx-side"[\s\S]*?<\/aside>/, side(page.slug));
}
export function publicFiles(opts = {}) {
  const f = { "explore/index.html": publicDocument({ index: true }, opts) };
  for (const p of PUBLIC_PAGES) f[`explore/${p.slug}/index.html`] = publicDocument(p, opts);
  return f;
}
