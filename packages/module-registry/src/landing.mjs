/**
 * landing.mjs — W2-P4 (req 11): one public landing per module, data-driven. Pure and dependency-free, so the SAME code
 * renders the page in four places: the module build (prerendered into index.html), the Express app (module host "/"), the
 * SPA gate (when the HTML was not prerendered) and the SEO/network tests. Copy and brand tokens live in LANDINGS below.
 *
 * Deliberately a static page: semantic HTML + a few lines of inline CSS (brand tokens), native <details> for the FAQ, no
 * script, no web fonts, no network request of any kind, so it never touches the API and scores well on SEO/performance.
 * Links stay inside the module (no outbound links to other modules or hosts).
 */
import { getModule } from "./index.mjs";

/** Brand tokens: one palette per module. `ink` is the text colour used ON the accent (buttons). */
export const LANDINGS = Object.freeze({
  sylo: {
    tagline: "Your credentials, entities and wallets in one vault.",
    hero: { eyebrow: "Sylo — Vault", title: "Keep every credential, entity and wallet in one locked-down vault", lead: "Sylo is where you store the accounts and keys you farm with, organised by entity, protected by a vault PIN and two-factor, and recoverable if something goes wrong." },
    features: [
      { title: "Entities, not scattered notes", text: "Group wallets, mail, KYC data and game accounts under the entity they belong to, and see everything about an entity on one screen." },
      { title: "A separate vault lock", text: "The vault has its own PIN on top of your sign-in, and sensitive entities can have their own PIN too." },
      { title: "Backup and emergency access", text: "Encrypted backups, plus emergency access so a person you trust can be let in if you cannot be reached." },
      { title: "Two-factor in the vault", text: "Keep authenticator codes next to the accounts they protect instead of in another app." },
    ],
    shards: "Start with a free Sylo account. Heavier usage is paid in Shards, AYZEN's usage credits, so you only pay when you grow.",
    faq: [["What is Sylo?", "Sylo is the vault module of AYZEN: a place to keep credentials, entities, wallets and related records, with its own lock."], ["Is the vault locked separately from my sign-in?", "Yes. Opening the vault asks for the vault PIN even when you are signed in."]],
    brand: { bg: "#0b1220", surface: "#131c30", fg: "#e8eefc", muted: "#a9b6d3", accent: "#38bdf8", ink: "#04121c" },
  },
  ryft: {
    tagline: "Wallet hub and wallet analysis.",
    hero: { eyebrow: "Ryft — Wallets", title: "See every wallet you use, and what it has done", lead: "Ryft brings your wallets into one hub and analyses their activity, so you know which wallets are ready, which are idle and what each one has already done." },
    features: [
      { title: "One hub for all wallets", text: "Add wallets once and manage them from a single list instead of a dozen explorers." },
      { title: "Wallet analysis", text: "Look at a wallet's activity and history to judge whether it is worth using for a project." },
      { title: "Built for many wallets", text: "Made for people who run lots of wallets, with the overview that makes that manageable." },
      { title: "Your own account", text: "Ryft has its own account and session, separate from every other AYZEN module." },
    ],
    shards: "Start with a free Ryft account. Heavier analysis is paid in Shards, AYZEN's usage credits.",
    faq: [["What is Ryft?", "Ryft is the wallet module of AYZEN: a wallet hub plus wallet analysis."], ["Does Ryft hold my funds?", "No. Ryft is a management and analysis tool; it is not a custodian."]],
    brand: { bg: "#100d1f", surface: "#1a1630", fg: "#efeaff", muted: "#b9b0d9", accent: "#a78bfa", ink: "#120a2a" },
  },
  fyra: {
    tagline: "Cash flow, loans, investments and assets.",
    hero: { eyebrow: "Fyra — Finance", title: "Know where your money is and where it is going", lead: "Fyra tracks cash flow, loans, investments and assets in one place and produces the receipts, invoices and payment agreements you need to share." },
    features: [
      { title: "Cash flow at a glance", text: "Record income and spending and see the trend instead of reconstructing it at month end." },
      { title: "Loans and investments", text: "Keep loans you owe or gave, and your investments, next to your cash so the whole picture adds up." },
      { title: "Assets", text: "Track what you own and what it is worth over time." },
      { title: "Shareable documents", text: "Create receipts, invoices and payment agreements with a public link for the other party." },
    ],
    shards: "Start with a free Fyra account. Heavier usage is paid in Shards, AYZEN's usage credits.",
    faq: [["What is Fyra?", "Fyra is the finance module of AYZEN: cash flow, loans, investments and assets."], ["Can I send a receipt to someone without an account?", "Yes. Receipts, invoices and payment agreements have public links that need no sign-in."]],
    brand: { bg: "#07140f", surface: "#0e2219", fg: "#e6f8ee", muted: "#a3c7b3", accent: "#34d399", ink: "#032016" },
  },
  verve: {
    tagline: "Marketplace and peer-to-peer trading.",
    hero: { eyebrow: "Verve — Marketplace", title: "Buy, sell and trade with other people", lead: "Verve is the AYZEN marketplace: listings, offers, carts and peer-to-peer trades, with reviews and reporting so you can tell who to trust." },
    features: [
      { title: "A marketplace hub", text: "Browse listings and categories from one hub, and keep your order history." },
      { title: "Offers and coupons", text: "Make and receive offers, and use coupons at checkout." },
      { title: "Peer-to-peer trading", text: "Trade directly with other people instead of through a middleman." },
      { title: "Reviews and reports", text: "Read reviews before you buy, and report listings that break the rules." },
    ],
    shards: "Start with a free Verve account. Heavier usage is paid in Shards, AYZEN's usage credits.",
    faq: [["What is Verve?", "Verve is the marketplace module of AYZEN: listings, offers and peer-to-peer trading."], ["Do I need another account to buy?", "You need a Verve account. It is separate from your accounts in other AYZEN modules."]],
    brand: { bg: "#1a0b10", surface: "#2a121b", fg: "#ffeaf0", muted: "#d9b0bd", accent: "#fb7185", ink: "#2a0610" },
  },
  skarn: {
    tagline: "Airdrop projects, tasks and operator progress.",
    hero: { eyebrow: "Skarn — Airdrops", title: "Run your airdrop projects like a checklist you can trust", lead: "Skarn tracks every airdrop project, its tasks and deadlines, and your progress, so nothing is missed between snapshot, task and token launch." },
    features: [
      { title: "Projects and tasks", text: "Keep each project with its tasks, notes and status in one place." },
      { title: "Dates that matter", text: "See snapshot, launch and deadline dates for all projects together on a calendar." },
      { title: "Operator progress", text: "Follow how far each operator or account has got through a project." },
      { title: "Compare projects", text: "Put projects side by side to decide where your time is best spent." },
    ],
    shards: "Start with a free Skarn account. Heavier usage is paid in Shards, AYZEN's usage credits.",
    faq: [["What is Skarn?", "Skarn is the airdrop module of AYZEN: projects, tasks and operator progress."], ["Is Skarn only for one person?", "No. You can work alone or with others on the same projects."]],
    brand: { bg: "#17120a", surface: "#241b0e", fg: "#fff4dc", muted: "#d4c298", accent: "#fbbf24", ink: "#241600" },
  },
  warde: {
    tagline: "Farming teams, chat and missions.",
    hero: { eyebrow: "Warde — Teams", title: "Farm together without losing track of who does what", lead: "Warde is the team module: build a farming team, talk in its chat and hand out missions so everyone knows what to do next." },
    features: [
      { title: "Teams", text: "Create a team, invite people and see who belongs to it." },
      { title: "Team chat", text: "Keep the conversation next to the work instead of in a separate app." },
      { title: "Missions", text: "Assign missions to members and follow them through to done." },
      { title: "Leaders get a view", text: "Team leaders get their own view for running the team." },
    ],
    shards: "Start with a free Warde account. Heavier usage is paid in Shards, AYZEN's usage credits.",
    faq: [["What is Warde?", "Warde is the teams module of AYZEN: farming teams, chat and missions."], ["Can I be in more than one team?", "Team membership is managed inside Warde by the team's leaders."]],
    brand: { bg: "#1a0f08", surface: "#2a180c", fg: "#ffeedf", muted: "#d9b89b", accent: "#fb923c", ink: "#2a1200" },
  },
  wisp: {
    tagline: "Your AYZEN mailbox and email accounts.",
    hero: { eyebrow: "Wisp — Mail", title: "One mailbox for the many addresses you farm with", lead: "Wisp gives you an AYZEN mailbox and lets you bring your other email accounts into one inbox, so verification mails never get lost." },
    features: [
      { title: "An AYZEN mailbox", text: "Get an address of your own and read and send mail from the web." },
      { title: "Bring your other accounts", text: "Connect other email accounts and read them in the same place." },
      { title: "Built for verification mail", text: "Find the confirmation and notification mails you need without searching five inboxes." },
      { title: "Your own account", text: "Wisp has its own account and session, separate from every other AYZEN module." },
    ],
    shards: "Start with a free Wisp account. Heavier usage, such as sending volume, is paid in Shards, AYZEN's usage credits.",
    faq: [["What is Wisp?", "Wisp is the mail module of AYZEN: a mailbox plus your connected email accounts."], ["Can I use my existing email addresses?", "You can connect other email accounts so their mail shows up in Wisp."]],
    brand: { bg: "#06151a", surface: "#0c242c", fg: "#e2f8fc", muted: "#9cc6cf", accent: "#22d3ee", ink: "#01202a" },
  },
  zynth: {
    tagline: "The AYZEN AI assistant.",
    hero: { eyebrow: "Zynth — AI assistant", title: "An assistant that knows your AYZEN workspace", lead: "Zynth is the AI assistant of AYZEN: ask questions in plain language and get help with the work you already do in the other modules." },
    features: [
      { title: "Ask in plain language", text: "Type what you need instead of hunting through menus." },
      { title: "A full-page assistant", text: "Work in a dedicated assistant page, or keep it as a panel next to what you are doing." },
      { title: "Works with your workspace", text: "Built to help with the tasks you run across AYZEN." },
      { title: "You stay in control", text: "Nothing happens in another module unless you connect it and allow it." },
    ],
    shards: "Start with a free Zynth account. Assistant usage is paid in Shards, AYZEN's usage credits.",
    faq: [["What is Zynth?", "Zynth is the AI assistant module of AYZEN."], ["Can Zynth act in my other modules?", "Only where you have connected the modules and allowed it."]],
    brand: { bg: "#160a1a", surface: "#24112b", fg: "#fbe9ff", muted: "#d8b4e2", accent: "#e879f9", ink: "#26072e" },
  },
});

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** @returns the full content set for a module (registry facts + copy + brand), or null. */
export function getLandingContent(id) {
  const m = getModule(id);
  const l = LANDINGS[id];
  if (!m || !l) return null;
  const faq = [
    ...l.faq,
    [`Do I need an AYZEN account to use ${m.label}?`, `${m.label} has its own account. You create it with your email; where enabled you can also continue with Google, Facebook, GitHub or your AYZEN account.`],
    [`Is my ${m.label} data shared with other AYZEN modules?`, `No. ${m.label} keeps its own account, session and data. Nothing is shared with other modules unless you choose to connect them.`],
    [`What does ${m.label} cost?`, `Starting is free. Heavier usage is paid in Shards, AYZEN's usage credits.`],
  ];
  return { id, label: m.label, host: m.defaultHost, homePath: m.homePath, ...l, faq };
}

export const landingIds = () => Object.keys(LANDINGS);

export function landingStyles(c) {
  const b = c.brand;
  return `:root{--bg:${b.bg};--surface:${b.surface};--fg:${b.fg};--muted:${b.muted};--accent:${b.accent};--ink:${b.ink};color-scheme:dark}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.ml a{color:inherit}.ml-h{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:16px clamp(16px,5vw,48px)}
.ml-brand{font-weight:700;font-size:1.25rem;text-decoration:none;color:var(--accent)}.ml-h nav{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.ml-h nav a{padding:10px 12px;min-height:44px;display:inline-flex;align-items:center;text-decoration:none;color:var(--muted)}.ml-h nav a:hover,.ml-h nav a:focus-visible{color:var(--fg)}
.ml-btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:12px 22px;border-radius:12px;background:var(--accent);color:var(--ink)!important;font-weight:700;text-decoration:none;border:2px solid var(--accent)}
.ml-btn.ml-ghost{background:transparent;color:var(--fg)!important;border-color:var(--muted)}.ml a:focus-visible,.ml summary:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.ml main{max-width:1080px;margin:0 auto;padding:0 clamp(16px,5vw,48px)}.ml section{padding:clamp(32px,7vw,72px) 0}
.ml-hero{padding-top:clamp(24px,6vw,64px)!important}.ml-eyebrow{margin:0 0 12px;color:var(--accent);font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-size:.85rem}
.ml h1{margin:0 0 16px;font-size:clamp(2rem,6vw,3.5rem);line-height:1.1}.ml h2{margin:0 0 24px;font-size:clamp(1.5rem,4vw,2.25rem)}.ml h3{margin:0 0 8px;font-size:1.1rem}
.ml-lead{max-width:60ch;font-size:1.15rem;color:var(--muted);margin:0 0 28px}.ml-cta{display:flex;flex-wrap:wrap;gap:12px}
.ml-grid{list-style:none;margin:0;padding:0;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}.ml-grid li{background:var(--surface);border-radius:16px;padding:20px;border:1px solid color-mix(in srgb,var(--accent) 25%,transparent)}
.ml-grid p{margin:0;color:var(--muted)}.ml-price{background:var(--surface);border-radius:20px;padding:clamp(20px,5vw,40px);border:1px solid color-mix(in srgb,var(--accent) 35%,transparent)}.ml-price p{max-width:60ch;color:var(--muted);margin:0 0 20px}
.ml details{background:var(--surface);border-radius:12px;margin:0 0 12px;padding:4px 16px}.ml summary{cursor:pointer;min-height:44px;display:flex;align-items:center;font-weight:600}.ml details p{margin:0 0 14px;color:var(--muted)}
.ml-f{display:flex;flex-wrap:wrap;gap:8px 20px;justify-content:space-between;padding:24px clamp(16px,5vw,48px) 40px;color:var(--muted);border-top:1px solid color-mix(in srgb,var(--muted) 25%,transparent)}.ml-f nav{display:flex;flex-wrap:wrap;gap:4px 8px}.ml-f a{padding:10px 8px;min-height:44px;display:inline-flex;align-items:center}`;
}

/** The page body (header, main, footer) as an HTML string. */
export function landingBody(c) {
  const L = esc(c.label);
  return `<div class="ml" data-module-landing="${esc(c.id)}">
<header class="ml-h"><a class="ml-brand" href="/" aria-label="${L} home">${L}</a><nav aria-label="Primary"><a href="#features">Features</a><a href="#pricing">Shards</a><a href="#faq">FAQ</a><a href="/login">Sign in to ${L}</a></nav></header>
<main>
<section class="ml-hero" aria-labelledby="ml-h1"><p class="ml-eyebrow">${esc(c.hero.eyebrow)}</p><h1 id="ml-h1">${esc(c.hero.title)}</h1><p class="ml-lead">${esc(c.hero.lead)}</p><div class="ml-cta"><a class="ml-btn" href="/register">Create your ${L} account</a><a class="ml-btn ml-ghost" href="/login">Sign in</a></div></section>
<section id="features" aria-labelledby="ml-features"><h2 id="ml-features">What you get with ${L}</h2><ul class="ml-grid">${c.features.map((f) => `<li><h3>${esc(f.title)}</h3><p>${esc(f.text)}</p></li>`).join("")}</ul></section>
<section id="pricing" aria-labelledby="ml-pricing"><div class="ml-price"><h2 id="ml-pricing">Start free, pay with Shards</h2><p>${esc(c.shards)}</p><a class="ml-btn" href="/register">Start free with ${L}</a></div></section>
<section id="faq" aria-labelledby="ml-faq"><h2 id="ml-faq">Questions about ${L}</h2>${c.faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</section>
</main>
<footer class="ml-f"><span>&copy; AYZEN. ${L} is a module of AYZEN.</span><nav aria-label="Footer"><a href="/login">Sign in</a><a href="/register">Create account</a><a href="/status">Service status</a></nav></footer>
</div>`;
}

const origin = (c, o) => (o ?? `https://${c.host}`).replace(/\/$/, "");

/** Head tags for SEO and sharing (title, description, canonical, robots, Open Graph, Twitter, JSON-LD). */
export function landingHead(c, opts = {}) {
  const base = origin(c, opts.origin);
  const title = `${c.label} — ${c.tagline.replace(/\.$/, "")} | AYZEN`;
  const desc = `${c.hero.lead}`.slice(0, 200).replace(/\s+\S*$/, (m) => (c.hero.lead.length > 200 ? "…" : m));
  const image = `${base}/og/${c.id}.png`;
  const ld = { "@context": "https://schema.org", "@type": "SoftwareApplication", name: c.label, description: c.tagline, applicationCategory: "BusinessApplication", operatingSystem: "Web", url: `${base}/`, image, offers: { "@type": "Offer", price: "0", priceCurrency: "USD", description: "Free to start" } };
  return { title, description: desc, canonical: `${base}/`, image, jsonLd: ld, themeColor: c.brand.bg, base };
}

export function landingHeadHtml(c, opts = {}) {
  const h = landingHead(c, opts);
  return `<title>${esc(h.title)}</title>
<meta name="description" content="${esc(h.description)}" />
<meta name="robots" content="index, follow" />
<link rel="canonical" href="${esc(h.canonical)}" />
<meta name="theme-color" content="${esc(h.themeColor)}" />
<meta property="og:type" content="website" /><meta property="og:site_name" content="${esc(c.label)}" /><meta property="og:title" content="${esc(h.title)}" />
<meta property="og:description" content="${esc(h.description)}" /><meta property="og:url" content="${esc(h.canonical)}" /><meta property="og:image" content="${esc(h.image)}" />
<meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" /><meta property="og:image:alt" content="${esc(c.label)} — ${esc(c.tagline)}" />
<meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="${esc(h.title)}" /><meta name="twitter:description" content="${esc(h.description)}" /><meta name="twitter:image" content="${esc(h.image)}" />
<script type="application/ld+json">${JSON.stringify(h.jsonLd).replace(/</g, "\\u003c")}</script>
<style id="module-landing-css">${landingStyles(c)}</style>`;
}

/** A complete standalone document (used by tests, and as the static fallback for hosts that serve no SPA). */
export function landingDocument(c, opts = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${landingHeadHtml(c, opts)}
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
</head>
<body>
${landingBody(c)}
</body>
</html>
`;
}

/**
 * Put the landing into the SPA shell (index.html): module head tags replace the generic ones, the prerendered body goes inside
 * #root, and a tiny inline script removes it again for everything except a signed-out visit to "/" so deep links never flash it.
 */
export function injectLandingIntoHtml(html, id, opts = {}) {
  const c = getLandingContent(id);
  if (!c) return html;
  const stripped = html
    .replace(/<title>[\s\S]*?<\/title>\s*/i, "")
    .replace(/<meta\s+(?:name|property)="(?:description|robots|og:[^"]*|twitter:[^"]*|theme-color)"[^>]*>\s*/gi, "")
    .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, "");
  const guard = `<script>(function(){try{var t=localStorage.getItem("ayzen_token")||sessionStorage.getItem("ayzen_token")}catch(e){}if(location.pathname!=="/"||t){var r=document.getElementById("root");if(r)r.textContent=""}})()</script>`;
  return stripped
    .replace("</head>", `${landingHeadHtml(c, opts)}\n</head>`)
    .replace(/<div id="root"><\/div>/, `<div id="root">${landingBody(c)}</div>\n${guard}`);
}

export function robotsTxt(id, opts = {}) {
  const c = getLandingContent(id);
  const base = c ? origin(c, opts.origin) : "";
  return `User-agent: *\nAllow: /$\nAllow: /og/\nAllow: /landing-assets/\nDisallow: /\n${base ? `Sitemap: ${base}/sitemap.xml\n` : ""}`;
}

export function sitemapXml(id, opts = {}) {
  const c = getLandingContent(id);
  if (!c) return "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${esc(origin(c, opts.origin))}/</loc></url>\n</urlset>\n`;
}
