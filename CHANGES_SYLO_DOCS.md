# Sylo documentation (public, indexable)

Sylo's `/docs` pages carry the full SYLO / AYZEN ecosystem notes (Utility and Use-Cases chapters only; tokenomics, governance and business model are deliberately not published), line for line.

- Content: `packages/module-registry/src/sylo-docs-data.mjs` (note text as written, Bengali + English; do not reword). Renderer: `sylo-docs.mjs` (pure, no script, no network).
- URLs: `/docs`, `/docs/<chapter>`, `/docs/<chapter>/<topic>` , server-rendered with title, description, canonical, robots, OG/Twitter, TechArticle / CollectionPage + BreadcrumbList JSON-LD, prev/next links.
- Discovery: `sitemap.xml` lists all docs URLs, `robots.txt` allows `/docs` (AI crawlers included), `llms.txt` links every chapter, `llms-full.txt` contains the whole documentation as markdown; About page nav has a Docs link.
- Served by: Express (`app.ts`, sylo host, same gate as `/about`) and the module/central builds (`emitModuleSite` writes `docs/**/index.html`).
- Tests: `packages/module-registry/test/sylo-docs.test.mjs` (SEO tags, every note line present in page and llms-full, sitemap/robots/llms).
- Not done: a Docs link inside the designed Sylo landing HTML (`public/landing/sylo/index.html`); search engines find the docs through the sitemap, About page and llms.txt.
- To add a page: edit the data file; paths, sitemap and llms update automatically.
