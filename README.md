# PosteBridge

**Link Hetzner DNS to Poste.io** — one UI to keep your mail domains in sync.

Running self-hosted mail on [Poste.io](https://poste.io) with DNS at [Hetzner Cloud](https://www.hetzner.com/cloud) means juggling two consoles: register the domain on Poste, copy MX/SPF/DKIM/DMARC into Hetzner, chunk long DKIM TXT records, create mailboxes, check what’s missing. PosteBridge connects both sides and shows only what still needs doing.

## What it links

| Hetzner DNS | ↔ | Poste.io |
|-------------|---|----------|
| Zones & record sets | | Registered domains |
| MX, SPF, DKIM, DMARC, autoconfig | | DKIM keys & mail host |
| Gap detection (skip what’s already correct) | | Domain registration & mailboxes |
| PTR / reverse DNS (optional) | | Webmail & admin |

**Email** view — work on one selected zone: DNS gaps, apply missing records (including auto-chunked DKIM), register on Poste.io, manage mailboxes, health check.

**Mail Manager** — fleet view: all Poste domains, Hetzner zone linkage, search, and zones that exist in Hetzner but aren’t on Poste yet.

Buttons disable when DNS is complete or the domain is already registered. **Full setup** applies pending DNS then registers the domain in one step.

## Quick start

```bash
cp .env.example .env
# HETZNER_API_KEY=...
# POSTE_BASE_URL=http://posteio.your-server.com
# POSTE_ADMIN_EMAIL=admin@yourdomain.com
# POSTE_ADMIN_PASSWORD=...

npm install
npm start
```

Open http://localhost:3847 — first run prints `root` and a one-time password to the console.

## Poste.io + Hetzner setup

```env
HETZNER_API_KEY=your-hetzner-cloud-api-token

POSTE_BASE_URL=http://posteio.your-server.com
POSTE_ADMIN_EMAIL=admin@yourdomain.com
POSTE_ADMIN_PASSWORD=your-admin-password
POSTE_MAIL_HOST=mail.yourdomain.com   # optional — defaults to mail.<domain>
```

Typical flow for a new domain:

1. Create the zone in Hetzner (or pick an existing zone).
2. Open **Email** → **Full setup** (or apply DNS, then register).
3. Confirm gaps are green in the health check.
4. Create mailboxes and open webmail.

Poste API docs: `{POSTE_BASE_URL}/admin/api/doc`

## Also included

- Zone & record CRUD (A, AAAA, CNAME, MX, TXT, SRV, CAA) — NS/SOA protected
- Global DNS propagation check (12 public resolvers)
- Legacy one-click mail DNS without Poste.io (A + MX + SPF + DMARC)
- Session login, SweetAlert2 UI, Docker-ready

## Docker

```bash
docker build -t postebridge .
docker run -p 3847:3847 -v postebridge-data:/app/data --env-file .env postebridge
```

Mount `/app/data` so login credentials survive redeploys. Behind HTTPS (e.g. Dokploy), set `COOKIE_SECURE=true` or login succeeds but the session won’t stick.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HETZNER_API_KEY` | Yes | — | Hetzner Cloud API token (DNS zones) |
| `POSTE_BASE_URL` | For mail | — | Poste.io server URL |
| `POSTE_ADMIN_EMAIL` | For mail | — | Poste.io admin email (API basic auth) |
| `POSTE_ADMIN_PASSWORD` | For mail | — | Poste.io admin password |
| `POSTE_MAIL_HOST` | No | `mail.<domain>` | Hostname in MX / autoconfig records |
| `PORT` | No | `3847` | HTTP port |
| `DATA_DIR` | No | `./data` | Auth credentials path |
| `COOKIE_SECURE` | No | `false` | `true` when served over HTTPS |
| `TRUST_PROXY` | No | enabled | `false` to ignore `X-Forwarded-*` |

## Login & password

First start generates credentials (shown once in logs). Change later:

```bash
npm run change-password
# Docker: docker exec -it <container> npm run change-password
```

Minimum 12 characters.

## API

Browser → local Express app → [Hetzner DNS API](https://docs.hetzner.cloud/reference/cloud#tag/zones) and Poste.io admin API. Keys stay server-side.

## License

MIT
