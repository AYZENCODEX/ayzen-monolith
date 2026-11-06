# Wisp landing page

`artifacts/ayzen/public/landing/wisp/index.html` — static, self-contained page (inline CSS/JS), served at `/landing/wisp/`.

- Concept: airmail correspondence. Fog paper-blue, ink navy, airmail red/blue used only on the envelope edge and the footer edge.
- Type: Bricolage Grotesque (headings), Literata (body), Courier Prime (typed mail). Self-hosted woff2 in `wisp/fonts/` (OFL licenses included).
- Interactions: live envelope address, looping 3D flip (back with wax seal and opening flap, 9s cycle, off under reduced motion), rules-sorting loop (from/to/subject, contains/equals, label/move/mark read/star), undo-send countdown (5/10/20/30s), sending-health pause/resume illustration, clickable cards with gray glow, "Let's talk" footer.
- Login links are absolute (`https://ayzen.tech/login`) so they also work when the file is opened locally; change them if the portal moves.
- Placeholder socials: set `SOCIAL_LINKS` in the script.
- Copy only states behaviour present in the code (address claim, forwarding or native mailbox, own SMTP/IMAP, rules, snooze, scheduled send, undo send, sending health, analytics). Sending and template use are credit-metered and the page says so. Health numbers are labelled as an illustration.
- Not wired to `wisp.ayzen.tech`: the server redirects `/` on module hosts to `/mailbox`.
