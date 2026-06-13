# PosteBridge

PosteBridge is a private Vue dashboard for DNS and Poste.io mail operations. It supports Hetzner Cloud DNS and Hostinger DNS, keeps provider credentials encrypted on disk, manages Poste domains and mailboxes, checks DNS propagation, and updates Hetzner reverse DNS.

## Start everything

```bash
docker compose up -d --build
docker compose logs postebridge
```

The first start prints a generated dashboard username and password once in the `postebridge` logs.

Open:

- PosteBridge: `http://localhost:3847`
- Poste.io initial setup: `http://localhost:8080/admin`

Complete Poste.io's initial admin setup, then open **PosteBridge → Settings** and enter:

- A Hetzner API key and/or Hostinger API token
- Poste URL `http://poste`
- The Poste.io admin email and password created in the setup screen
- An optional public mail hostname such as `mail.example.com`

No `.env` file is used for credentials.

## Use an existing Poste.io server

If Poste.io is already installed separately on the same server, launch only
PosteBridge:

```bash
docker compose -f compose.standalone.yaml up -d --build
docker compose -f compose.standalone.yaml logs postebridge
```

If port `3847` is already in use:

```bash
POSTEBRIDGE_PORT=3857 \
  docker compose -f compose.standalone.yaml up -d --build
```

Then open **Settings** and use the host-published Poste.io URL:

```text
http://host.docker.internal:8080
```

Replace `8080` with the port exposed by the existing Poste.io installation.
`host.docker.internal` works on Docker Desktop and is mapped to the Docker host
by the standalone Compose file on Linux.

## Persistent data

The bundled Compose stack creates two named volumes:

| Volume | Contents |
|---|---|
| `postebridge-data` | Dashboard login, session secret, encrypted provider settings |
| `poste-data` | Poste.io users, mail, DKIM keys, certificates, configuration, and logs |

The standalone Compose file creates only `postebridge-data`. It does not mount,
modify, restart, or otherwise manage the existing Poste.io installation.

Redeploying or rebuilding the containers keeps both volumes:

```bash
docker compose up -d --build
```

For standalone mode:

```bash
docker compose -f compose.standalone.yaml up -d --build
```

Do not run `docker compose down -v` unless you intentionally want to delete credentials and mail data.

## Mail ports

The bundled Poste.io service publishes SMTP, POP3, IMAP, submission, and Sieve ports:

`25`, `110`, `143`, `465`, `587`, `993`, `995`, and `4190`.

Poste's HTTP setup UI is mapped to host port `8080`. The Compose default uses `HTTPS=OFF` so PosteBridge can call the Poste API over the private Docker network. Put the public web UI behind your TLS reverse proxy for production.

An internet-facing mail server also needs:

- A public static IP
- Port forwarding and firewall rules for the required mail ports
- PTR/reverse DNS matching the mail hostname
- Correct MX, SPF, DKIM, and DMARC records

PosteBridge can apply the DNS records and set Hetzner PTR records.

## Provider behavior

### Hetzner

- List, create, and delete zones
- Create, edit, and delete record sets
- List cloud servers and update PTR records

### Hostinger

- List domains from the Hostinger account portfolio
- Read, update, validate-compatible, and delete DNS records
- Apply Poste.io DNS records

Hostinger's API does not expose creation or deletion of an empty DNS zone. Add or remove domains through Hostinger hPanel; they then appear in PosteBridge.

## Local development

```bash
npm install
npm run build
npm start
```

For frontend development, run the API and Vite in separate terminals:

```bash
npm run dev:server
npm run dev
```

Vite runs on `http://localhost:5173` and proxies API calls to port `3847`.

## Profile

Change the dashboard username and password in **Settings → Profile**. Passwords must contain at least 12 characters.

The CLI fallback remains available:

```bash
npm run change-password
```

## Data security

Provider credentials are encrypted with AES-256-GCM before being written to `/app/data/settings.enc`. The encryption key is derived from the persistent, randomly generated dashboard session secret. Files are created with owner-only permissions and the container runs as a non-root user.
