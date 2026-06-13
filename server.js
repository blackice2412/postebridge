import "dotenv/config";
import express from "express";
import session from "express-session";
import path from "path";
import { fileURLToPath } from "url";
import {
  ensureAuth,
  getSessionSecret,
  verifyLogin,
  generatePassword,
  USERNAME,
} from "./lib/auth.js";
import { runDnsCheck, SUPPORTED_TYPES } from "./lib/dns-checker.js";
import {
  isPosteConfigured,
  getPosteConfig,
  getPosteDomain,
  registerPosteDomain,
  fetchPosteDnsBundle,
  buildPosteRrsets,
  listMailboxesForDomain,
  listPosteDomains,
  getPosteUrls,
  createPosteMailbox,
  deletePosteMailbox,
  resetPosteMailboxPassword,
  resolveMailHost,
  ensurePosteDkim,
  getPosteDomainQuota,
} from "./lib/poste.js";
import { analyzeDnsGaps } from "./lib/dns-gap.js";
import { formatTxt, parseTxtContent } from "./lib/txt-dns.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3847;
const API_BASE = "https://api.hetzner.cloud/v1";

const apiKey = process.env.HETZNER_API_KEY;
if (!apiKey) {
  console.error("HETZNER_API_KEY is required in .env");
  process.exit(1);
}

const PUBLIC_PATHS = new Set([
  "/login",
  "/login.html",
  "/login.js",
  "/styles.css",
]);

app.use(express.json());

await ensureAuth();
const sessionSecret = await getSessionSecret();

// Behind Dokploy/nginx TLS termination the app sees HTTP unless proxy is trusted.
if (process.env.TRUST_PROXY !== "false") {
  app.set("trust proxy", 1);
}

const cookieSecure = process.env.COOKIE_SECURE === "true";

app.use(
  session({
    name: "postebridge.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecure,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

function isAuthenticated(req) {
  return req.session?.user === USERNAME;
}

function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.path === "/api/auth/login") return next();
  if (isAuthenticated(req)) return next();

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return res.redirect("/login");
}

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }

    const valid = await verifyLogin(username, password);
    if (!valid) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    req.session.user = USERNAME;
    req.session.save((err) => {
      if (err) {
        return res.status(500).json({ error: "Could not create session" });
      }
      res.json({ ok: true, username: USERNAME });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/auth/me", (req, res) => {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({ username: USERNAME });
});

app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.use(requireAuth);
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/dns-check", async (req, res) => {
  try {
    const { hostname, types, expected } = req.body;
    const data = await runDnsCheck({ hostname, types, expected });
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/dns-check/types", (_req, res) => {
  res.json({ types: [...SUPPORTED_TYPES] });
});

async function hetzner(pathname, options = {}) {
  const url = `${API_BASE}${pathname}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: { message: text || res.statusText } };
  }

  if (!res.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      `Hetzner API error (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.details = data?.error?.details;
    throw err;
  }

  return data;
}

async function fetchAllPages(pathname, key) {
  const items = [];
  let page = 1;

  while (true) {
    const sep = pathname.includes("?") ? "&" : "?";
    const data = await hetzner(`${pathname}${sep}page=${page}&per_page=50`);
    items.push(...(data[key] || []));

    const pagination = data.meta?.pagination;
    if (!pagination || page >= pagination.last_page) break;
    page += 1;
  }

  return items;
}

function encodeRrsetName(name) {
  // Hetzner apex RRSets must use literal "@" in the path — %40 returns 404.
  if (name === "@") return "@";
  return encodeURIComponent(name);
}

function normalizeTxtValue(value) {
  return parseTxtContent(value);
}

function rrsetNamesEquivalent(a, b, zoneName) {
  const norm = (name) => {
    if (!name || name === "@" || name === zoneName) return "@";
    if (zoneName && name.endsWith(`.${zoneName}`)) {
      const label = name.slice(0, -(zoneName.length + 1));
      return label || "@";
    }
    return name;
  };
  return norm(a) === norm(b);
}

function isSpfTxt(value) {
  return normalizeTxtValue(value).toLowerCase().startsWith("v=spf1");
}

function isDmarcTxt(value) {
  return normalizeTxtValue(value).toLowerCase().startsWith("v=dmarc1");
}

function dedupeTxtRecords(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = normalizeTxtValue(record.value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeTxtRecords(existing, incoming, { replaceSpf = true, replaceDmarc = false } = {}) {
  let kept = [...existing];

  if (replaceSpf) {
    kept = kept.filter((record) => !isSpfTxt(record.value));
  }
  if (replaceDmarc) {
    kept = kept.filter((record) => !isDmarcTxt(record.value));
  }

  return dedupeTxtRecords([...kept, ...incoming]);
}

function recordsEquivalent(type, left, right) {
  const norm = (value) =>
    type === "TXT" ? normalizeTxtValue(value) : String(value).trim().replace(/\s+/g, " ");
  const leftValues = [...left].map((r) => norm(r.value)).sort();
  const rightValues = [...right].map((r) => norm(r.value)).sort();
  return leftValues.join("\n") === rightValues.join("\n");
}

async function findRrset(zoneId, name, type, zoneName) {
  const rrsets = await fetchAllPages(`/zones/${zoneId}/rrsets`, "rrsets");
  return (
    rrsets.find(
      (rrset) => rrset.type === type && rrsetNamesEquivalent(rrset.name, name, zoneName)
    ) || null
  );
}

async function resolveZoneName(zoneId, zoneName) {
  if (zoneName) return zoneName;
  const data = await hetzner(`/zones/${zoneId}`);
  return data.zone?.name;
}

async function setRrsetRecords(zoneId, name, type, ttl, records) {
  const encodedName = encodeRrsetName(name);
  return hetzner(
    `/zones/${zoneId}/rrsets/${encodedName}/${type}/actions/set_records`,
    {
      method: "POST",
      body: JSON.stringify({ ttl, records }),
    }
  );
}

async function upsertRrset(zoneId, { name, type, ttl, records }, options = {}) {
  const { zoneName: zoneNameInput, mergeTxt = false, replaceDmarc = false } = options;
  const zoneName = await resolveZoneName(zoneId, zoneNameInput);
  const existing = await findRrset(zoneId, name, type, zoneName);
  const apiName = existing?.name ?? name;

  let finalRecords = records;
  if (mergeTxt && type === "TXT" && existing?.records?.length) {
    finalRecords = mergeTxtRecords(existing.records, records, { replaceSpf: true, replaceDmarc });
    if (recordsEquivalent(type, existing.records, finalRecords)) {
      return { action: { status: "success", command: "noop" }, unchanged: true };
    }
  } else if (existing?.records?.length && recordsEquivalent(type, existing.records, records)) {
    return { action: { status: "success", command: "noop" }, unchanged: true };
  }

  try {
    return await setRrsetRecords(zoneId, apiName, type, ttl, finalRecords);
  } catch (err) {
    const notFound =
      err.status === 404 || err.message?.toLowerCase().includes("not found");
    const alreadyExists =
      err.status === 409 || err.message?.toLowerCase().includes("already exist");

    if (alreadyExists) {
      const resolved = await findRrset(zoneId, name, type, zoneName);
      if (resolved) {
        return setRrsetRecords(zoneId, resolved.name, type, ttl, finalRecords);
      }
    }

    if (!notFound) throw err;

    try {
      return await hetzner(`/zones/${zoneId}/rrsets`, {
        method: "POST",
        body: JSON.stringify({ name, type, ttl, records: finalRecords }),
      });
    } catch (createErr) {
      const createExists =
        createErr.status === 409 ||
        createErr.message?.toLowerCase().includes("already exist");
      if (!createExists) throw createErr;

      const resolved = await findRrset(zoneId, name, type, zoneName);
      if (!resolved) throw createErr;
      return setRrsetRecords(zoneId, resolved.name, type, ttl, finalRecords);
    }
  }
}

const PROTECTED_RRSET_TYPES = new Set(["NS", "SOA"]);

function assertRrsetMutable(type) {
  if (PROTECTED_RRSET_TYPES.has(type)) {
    const err = new Error(`${type} records cannot be modified or deleted`);
    err.status = 403;
    throw err;
  }
}

app.get("/api/zones", async (_req, res) => {
  try {
    const zones = await fetchAllPages("/zones", "zones");
    res.json({ zones });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/zones", async (req, res) => {
  try {
    const { name, ttl = 3600 } = req.body;
    if (!name) return res.status(400).json({ error: "Zone name is required" });

    const data = await hetzner("/zones", {
      method: "POST",
      body: JSON.stringify({ name, mode: "primary", ttl }),
    });
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/zones/:zoneId/rrsets", async (req, res) => {
  try {
    const rrsets = await fetchAllPages(
      `/zones/${req.params.zoneId}/rrsets`,
      "rrsets"
    );
    res.json({ rrsets });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/zones/:zoneId/rrsets", async (req, res) => {
  try {
    const { name, type, ttl = 3600, records } = req.body;
    if (!name || !type || !records?.length) {
      return res.status(400).json({ error: "name, type, and records are required" });
    }
    assertRrsetMutable(type);

    const data = await hetzner(`/zones/${req.params.zoneId}/rrsets`, {
      method: "POST",
      body: JSON.stringify({ name, type, ttl, records }),
    });
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.put("/api/zones/:zoneId/rrsets/:name/:type", async (req, res) => {
  try {
    const { zoneId, name, type } = req.params;
    assertRrsetMutable(type);
    const { ttl, records } = req.body;
    if (!records?.length) {
      return res.status(400).json({ error: "records are required" });
    }

    const data = await upsertRrset(zoneId, { name, type, ttl, records });
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete("/api/zones/:zoneId/rrsets/:name/:type", async (req, res) => {
  try {
    const { zoneId, name, type } = req.params;
    assertRrsetMutable(type);
    const encodedName = encodeRrsetName(name);
    const data = await hetzner(
      `/zones/${zoneId}/rrsets/${encodedName}/${type}`,
      { method: "DELETE" }
    );
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete("/api/zones/:zoneId", async (req, res) => {
  try {
    const data = await hetzner(`/zones/${req.params.zoneId}`, { method: "DELETE" });
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/servers", async (_req, res) => {
  try {
    const servers = await fetchAllPages("/servers", "servers");
    res.json({
      servers: servers.map((s) => ({
        id: s.id,
        name: s.name,
        ipv4: s.public_net?.ipv4?.ip,
        ipv4_id: s.public_net?.ipv4?.id,
        dns_ptr: s.public_net?.ipv4?.dns_ptr,
        ipv6: s.public_net?.ipv6?.ip,
      })),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/servers/:serverId/rdns", async (req, res) => {
  try {
    const { ip, dns_ptr } = req.body;
    if (!ip || !dns_ptr) {
      return res.status(400).json({ error: "ip and dns_ptr are required" });
    }

    const cleanPtr = dns_ptr.replace(/\.$/, "");
    const data = await hetzner(
      `/servers/${req.params.serverId}/actions/change_dns_ptr`,
      {
        method: "POST",
        body: JSON.stringify({ ip, dns_ptr: cleanPtr }),
      }
    );
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/zones/:zoneId/mail-setup", async (req, res) => {
  try {
    const { zoneId } = req.params;
    const {
      domain,
      mailHost = "mail",
      ipv4,
      mxPriority = 10,
      dmarcEmail,
      spf = "v=spf1 mx ~all",
    } = req.body;

    if (!domain || !ipv4) {
      return res.status(400).json({ error: "domain and ipv4 are required" });
    }

    const mailFqdn = `${mailHost}.${domain}.`;
    const dmarcRua = dmarcEmail || `postmaster@${domain}`;
    const records = [
      {
        name: mailHost,
        type: "A",
        ttl: 3600,
        records: [{ value: ipv4, comment: "Mail server" }],
      },
      {
        name: "@",
        type: "MX",
        ttl: 3600,
        records: [{ value: `${mxPriority} ${mailFqdn}`, comment: "Mail exchange" }],
      },
      {
        name: "@",
        type: "TXT",
        ttl: 3600,
        records: [{ value: formatTxt(spf), comment: "SPF" }],
      },
      {
        name: "_dmarc",
        type: "TXT",
        ttl: 3600,
        records: [
          {
            value: formatTxt(`v=DMARC1; p=none; rua=mailto:${dmarcRua}`),
            comment: "DMARC",
          },
        ],
      },
    ];

    const results = [];
    for (const rrset of records) {
      try {
        const data = await upsertRrset(zoneId, rrset, {
          zoneName: domain,
          mergeTxt: rrset.type === "TXT",
          replaceDmarc: rrset.name === "_dmarc",
        });
        results.push({
          name: rrset.name,
          type: rrset.type,
          status: "ok",
          unchanged: Boolean(data.unchanged),
          data,
        });
      } catch (err) {
        results.push({
          name: rrset.name,
          type: rrset.type,
          status: "error",
          error: err.message,
        });
      }
    }

    res.json({ results, mailFqdn: mailFqdn.replace(/\.$/, "") });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

function requirePoste(_req, res, next) {
  if (!isPosteConfigured()) {
    return res.status(503).json({
      error: "POSTE_BASE_URL, POSTE_ADMIN_EMAIL, and POSTE_ADMIN_PASSWORD are required",
    });
  }
  next();
}

async function applyRrsetsToZone(zoneId, domain, rrsets) {
  const results = [];
  for (const rrset of rrsets) {
    try {
      const data = await upsertRrset(zoneId, rrset, {
        zoneName: domain,
        mergeTxt: Boolean(rrset.mergeTxt),
        replaceDmarc: Boolean(rrset.replaceDmarc),
      });
      results.push({
        name: rrset.name,
        type: rrset.type,
        status: "ok",
        unchanged: Boolean(data.unchanged),
        data,
      });
    } catch (err) {
      results.push({
        name: rrset.name,
        type: rrset.type,
        status: "error",
        error: err.message,
      });
    }
  }
  return results;
}

app.get("/api/poste/status", (_req, res) => {
  if (!isPosteConfigured()) {
    return res.json({ configured: false });
  }
  try {
    const { baseUrl, email } = getPosteConfig();
    const domain = _req.query.domain;
    res.json({
      configured: true,
      baseUrl,
      mailHost: domain ? resolveMailHost(domain) : null,
      adminEmail: email,
      ...getPosteUrls(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/poste/domains", requirePoste, async (_req, res) => {
  try {
    const domains = await listPosteDomains();
    res.json({ domains });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/poste/overview", requirePoste, async (_req, res) => {
  try {
    const [posteDomains, hetznerZones] = await Promise.all([
      listPosteDomains(),
      fetchAllPages("/zones", "zones"),
    ]);
    const zoneByName = new Map(hetznerZones.map((zone) => [zone.name, zone.id]));
    const posteNames = new Set(posteDomains.map((domain) => domain.name));
    const domains = await Promise.all(
      posteDomains.map(async (domain) => {
        const mailboxes = await listMailboxesForDomain(domain.name);
        return {
          ...domain,
          mailboxCount: mailboxes.length,
          hetznerZoneId: zoneByName.get(domain.name) || null,
        };
      })
    );
    const unmanagedZones = hetznerZones
      .filter((zone) => !posteNames.has(zone.name))
      .map((zone) => ({ name: zone.name, hetznerZoneId: zone.id }));
    const totalMailboxes = domains.reduce((sum, domain) => sum + domain.mailboxCount, 0);

    res.json({
      domains,
      unmanagedZones,
      totals: {
        posteDomains: domains.length,
        mailboxes: totalMailboxes,
        unlinked: domains.filter((domain) => !domain.hetznerZoneId).length,
        unmanagedZones: unmanagedZones.length,
      },
      ...getPosteUrls(),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/poste/domains/:name/health", requirePoste, async (req, res) => {
  try {
    const domain = req.params.name;
    const { zoneId, dmarcEmail } = req.query;
    const posteDomain = await getPosteDomain(domain);
    const mailboxes = await listMailboxesForDomain(domain);
    const dns = await fetchPosteDnsBundle(domain, { dmarcEmail });

    let quota = await getPosteDomainQuota(domain);
    let dkim = null;
    try {
      dkim = await ensurePosteDkim(domain);
    } catch {
      dkim = null;
    }

    let gaps = null;
    let toApply = null;
    let dnsComplete = null;
    if (zoneId) {
      const rrsets = await fetchAllPages(`/zones/${zoneId}/rrsets`, "rrsets");
      const analysis = analyzeDnsGaps(domain, dns, rrsets, formatTxt);
      gaps = analysis.gaps;
      toApply = analysis.toApply;
      dnsComplete = Object.values(gaps).every((gap) => gap.status === "present");
    }

    res.json({
      domain,
      registered: Boolean(posteDomain),
      posteDomain,
      mailHost: resolveMailHost(domain),
      mailboxCount: mailboxes.length,
      mailboxes,
      quota,
      dkim: dkim
        ? { selector: String(dkim.selector || "").trim(), configured: Boolean(dkim.public) }
        : null,
      gaps,
      toApply,
      dnsComplete,
      ...getPosteUrls(),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/poste/domains/:name", requirePoste, async (req, res) => {
  try {
    const domain = await getPosteDomain(req.params.name);
    res.json({ registered: Boolean(domain), domain });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/poste/domains/:name/dns", requirePoste, async (req, res) => {
  try {
    const { dmarcEmail, zoneId } = req.query;
    const domain = req.params.name;
    const dns = await fetchPosteDnsBundle(domain, { dmarcEmail });
    const mailHost = resolveMailHost(domain);

    let gaps = null;
    let toApply = null;
    if (zoneId) {
      const rrsets = await fetchAllPages(`/zones/${zoneId}/rrsets`, "rrsets");
      const analysis = analyzeDnsGaps(domain, dns, rrsets, formatTxt);
      gaps = analysis.gaps;
      toApply = analysis.toApply;
    }

    res.json({ dns, gaps, toApply, mailHost });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/poste/domains/:name/register", requirePoste, async (req, res) => {
  try {
    const existing = await getPosteDomain(req.params.name);
    if (existing) {
      return res.json({ ok: true, domain: existing, alreadyExists: true });
    }
    const data = await registerPosteDomain(req.params.name);
    res.status(201).json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/zones/:zoneId/poste-setup", requirePoste, async (req, res) => {
  try {
    const { zoneId } = req.params;
    const { domain, dmarcEmail, register = false } = req.body;
    if (!domain) return res.status(400).json({ error: "domain is required" });

    const dns = await fetchPosteDnsBundle(domain, { dmarcEmail });
    const rrsets = await fetchAllPages(`/zones/${zoneId}/rrsets`, "rrsets");
    const { gaps, toApply } = analyzeDnsGaps(domain, dns, rrsets, formatTxt);
    const dnsResults = await applyRrsetsToZone(zoneId, domain, toApply);

    let registration = null;
    if (register) {
      try {
        const existing = await getPosteDomain(domain);
        if (existing) {
          registration = { status: "ok", data: existing, alreadyExists: true };
        } else {
          registration = { status: "ok", data: await registerPosteDomain(domain) };
        }
      } catch (err) {
        registration = { status: "error", error: err.message };
      }
    }

    res.json({ dns, gaps, toApply, dnsResults, registration, mailHost: resolveMailHost(domain) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/poste/mailboxes", requirePoste, async (req, res) => {
  try {
    const { domain } = req.query;
    if (!domain) return res.status(400).json({ error: "domain query param is required" });
    const mailboxes = await listMailboxesForDomain(domain);
    res.json({ mailboxes });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/poste/mailboxes", requirePoste, async (req, res) => {
  try {
    const { address, password, name, generate } = req.body;
    if (!address) return res.status(400).json({ error: "address is required" });

    const mailboxPassword = password || (generate ? generatePassword(16) : null);
    if (!mailboxPassword) {
      return res.status(400).json({ error: "password is required (or set generate: true)" });
    }

    const data = await createPosteMailbox({
      address,
      password: mailboxPassword,
      name,
    });
    res.status(201).json({ ...data, generatedPassword: password ? undefined : mailboxPassword });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete("/api/poste/mailboxes/:address", requirePoste, async (req, res) => {
  try {
    await deletePosteMailbox(req.params.address);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.patch("/api/poste/mailboxes/:address/password", requirePoste, async (req, res) => {
  try {
    const { password, generate } = req.body;
    const newPassword = password || (generate ? generatePassword(16) : null);
    if (!newPassword) {
      return res.status(400).json({ error: "password is required (or set generate: true)" });
    }

    await resetPosteMailboxPassword(req.params.address, newPassword);
    res.json({ ok: true, generatedPassword: password ? undefined : newPassword });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`PosteBridge running at http://localhost:${PORT}`);
});
