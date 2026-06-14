import express from "express";
import session from "express-session";
import sessionFileStore from "session-file-store";
import path from "path";
import { fileURLToPath } from "url";
import {
  ensureAuth,
  getDataDir,
  getSessionSecret,
  getProfile,
  updateProfile,
  verifyLogin,
  generatePassword,
} from "./lib/auth.js";
import {
  addConnection,
  deleteConnection,
  getConnection,
  getPublicSettings,
  getSettings,
  loadSettings,
  updateSettings,
} from "./lib/settings.js";
import { createHostingerClient } from "./lib/hostinger.js";
import { runDnsCheck, runDnsCheckStreaming, SUPPORTED_TYPES } from "./lib/dns-checker.js";
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
  syncAdminMailboxPassword,
  verifyPosteConnection,
  resolveMailHost,
  ensurePosteDkim,
  getPosteDomainQuota,
  setPosteConfigProvider,
} from "./lib/poste.js";
import { analyzeDnsGaps } from "./lib/dns-gap.js";
import { formatTxt, parseTxtContent } from "./lib/txt-dns.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3847;
const API_BASE = "https://api.hetzner.cloud/v1";
const FRONTEND_PATH = path.join(__dirname, "dist");
const FileStore = sessionFileStore(session);
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

const PUBLIC_PATHS = new Set(["/login"]);

app.use(express.json());

await ensureAuth();
await loadSettings();
setPosteConfigProvider(() => getSettings().poste);
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
    store: new FileStore({
      path: path.join(getDataDir(), "sessions"),
      ttl: SESSION_MAX_AGE / 1000,
      retries: 1,
    }),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecure,
      maxAge: SESSION_MAX_AGE,
    },
  })
);

function isAuthenticated(req) {
  return req.session?.authenticated === true;
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

    const profile = await getProfile();
    req.session.authenticated = true;
    req.session.username = profile.username;
    req.session.save((err) => {
      if (err) {
        return res.status(500).json({ error: "Could not create session" });
      }
      res.json({ ok: true, username: profile.username });
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

app.get("/api/auth/me", async (req, res) => {
  if (!isAuthenticated(req)) {
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true, ...(await getProfile()) });
});

app.use(express.static(FRONTEND_PATH, { index: false }));

app.get("/login", (_req, res) => {
  res.sendFile(path.join(FRONTEND_PATH, "index.html"));
});

app.use(requireAuth);
app.get("/", (_req, res) => {
  res.sendFile(path.join(FRONTEND_PATH, "index.html"));
});

app.get("/api/settings", (_req, res) => {
  res.json(getPublicSettings());
});

app.put("/api/settings", async (req, res) => {
  try {
    let mailboxPasswordSynced = false;
    if (req.body.poste) {
      const current = getSettings();
      const mergedPoste = { ...current.poste };
      for (const field of ["baseUrl", "adminEmail", "adminPassword", "mailHost"]) {
        if (req.body.poste[field] !== undefined) {
          mergedPoste[field] = String(req.body.poste[field]).trim();
        }
      }
      mergedPoste.baseUrl = mergedPoste.baseUrl.replace(/\/$/, "");

      if (req.body.poste.adminPassword !== undefined && mergedPoste.adminPassword) {
        const sync = await syncAdminMailboxPassword(current.poste, mergedPoste);
        mailboxPasswordSynced = sync.synced;
      }

      if (
        mergedPoste.baseUrl &&
        mergedPoste.adminEmail &&
        mergedPoste.adminPassword
      ) {
        await verifyPosteConnection(mergedPoste);
      }
    }
    const settings = await updateSettings(req.body);
    res.json({ ...settings, mailboxPasswordSynced });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/connections", async (req, res) => {
  try {
    const details = await getConnectionDetails(req.body);
    const connection = await addConnection(req.body);
    res.status(201).json({
      connection,
      details,
      settings: getPublicSettings(),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete("/api/connections/:connectionId", async (req, res) => {
  try {
    res.json(await deleteConnection(req.params.connectionId));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/connections/:connectionId/details", async (req, res) => {
  try {
    const connection = getConnection(req.params.connectionId);
    if (!connection) {
      return res.status(404).json({ error: "Connection not found" });
    }
    res.json(await getConnectionDetails(connection));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/profile", async (_req, res) => {
  res.json(await getProfile());
});

app.patch("/api/profile", async (req, res) => {
  try {
    const profile = await updateProfile(req.body);
    req.session.username = profile.username;
    res.json(profile);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/dns-check", async (req, res) => {
  try {
    const { hostname, types, expected } = req.body;
    const data = await runDnsCheck({ hostname, types, expected });
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/dns-check/stream", async (req, res) => {
  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const { hostname, types, expected } = req.body;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const result = await runDnsCheckStreaming({
      hostname,
      types,
      expected,
      onCheck(check) {
        send({ event: "check", check });
      },
    });
    send({ event: "done", ...result });
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(400).json({ error: err.message });
      return;
    }
    send({ event: "error", error: err.message });
    res.end();
  }
});

app.get("/api/dns-check/types", (_req, res) => {
  res.json({ types: [...SUPPORTED_TYPES] });
});

function connectionForRequest(req) {
  const settings = getSettings();
  const requestedId = req.query.connectionId || req.body?.connectionId;
  if (requestedId) {
    const connection = getConnection(requestedId);
    if (!connection) {
      const err = new Error("Connection not found");
      err.status = 404;
      throw err;
    }
    return connection;
  }

  const requestedProvider = req.query.provider || req.body?.provider;
  const active = getConnection(settings.activeConnectionId);
  if (!requestedProvider || active?.provider === requestedProvider) {
    if (active) return active;
  }

  const matches = settings.connections.filter(
    (connection) => connection.provider === requestedProvider
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const err = new Error("Choose a specific connection");
    err.status = 400;
    throw err;
  }

  const err = new Error("Add a DNS connection in Settings");
  err.status = 503;
  throw err;
}

async function hetzner(pathname, options = {}, connection = getConnection()) {
  const apiKey = connection?.apiKey;
  if (!apiKey) {
    const err = new Error("Configure a Hetzner API key in Settings");
    err.status = 503;
    throw err;
  }
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
    const err = new Error(`Hetzner DNS: ${message}`);
    err.status = res.status;
    err.details = data?.error?.details;
    throw err;
  }

  return data;
}

function hostingerClient(connection = getConnection()) {
  return createHostingerClient(connection?.apiKey || connection?.apiToken);
}

async function listZones(connection) {
  if (connection.provider === "hostinger") {
    return hostingerClient(connection).listZones();
  }
  return fetchAllPages("/zones", "zones", connection);
}

async function listRrsets(connection, zoneId) {
  if (connection.provider === "hostinger") {
    return hostingerClient(connection).listRrsets(zoneId);
  }
  return fetchAllPages(`/zones/${zoneId}/rrsets`, "rrsets", connection);
}

async function fetchAllPages(pathname, key, connection) {
  const items = [];
  let page = 1;

  while (true) {
    const sep = pathname.includes("?") ? "&" : "?";
    const data = await hetzner(
      `${pathname}${sep}page=${page}&per_page=50`,
      {},
      connection
    );
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

async function findRrset(zoneId, name, type, zoneName, connection) {
  const rrsets = await fetchAllPages(
    `/zones/${zoneId}/rrsets`,
    "rrsets",
    connection
  );
  return (
    rrsets.find(
      (rrset) => rrset.type === type && rrsetNamesEquivalent(rrset.name, name, zoneName)
    ) || null
  );
}

async function resolveZoneName(zoneId, zoneName, connection) {
  if (zoneName) return zoneName;
  const data = await hetzner(`/zones/${zoneId}`, {}, connection);
  return data.zone?.name;
}

async function setRrsetRecords(zoneId, name, type, ttl, records, connection) {
  const encodedName = encodeRrsetName(name);
  return hetzner(
    `/zones/${zoneId}/rrsets/${encodedName}/${type}/actions/set_records`,
    {
      method: "POST",
      body: JSON.stringify({ ttl, records }),
    },
    connection
  );
}

async function upsertRrset(zoneId, { name, type, ttl, records }, options = {}) {
  const {
    zoneName: zoneNameInput,
    mergeTxt = false,
    replaceDmarc = false,
    connection = getConnection(),
  } = options;
  const provider = connection?.provider;

  if (provider === "hostinger") {
    let finalRecords = records;
    if (mergeTxt && type === "TXT") {
      const rrsets = await listRrsets(connection, zoneId);
      const existing = rrsets.find(
        (rrset) =>
          rrset.type === type &&
          rrsetNamesEquivalent(rrset.name, name, zoneNameInput || zoneId)
      );
      if (existing?.records?.length) {
        finalRecords = mergeTxtRecords(existing.records, records, {
          replaceSpf: true,
          replaceDmarc,
        });
        if (recordsEquivalent(type, existing.records, finalRecords)) {
          return { unchanged: true };
        }
      }
    }
    return hostingerClient(connection).upsertRrset(zoneId, {
      name,
      type,
      ttl,
      records: finalRecords,
    });
  }

  const zoneName = await resolveZoneName(zoneId, zoneNameInput, connection);
  const existing = await findRrset(zoneId, name, type, zoneName, connection);
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
    return await setRrsetRecords(
      zoneId,
      apiName,
      type,
      ttl,
      finalRecords,
      connection
    );
  } catch (err) {
    const notFound =
      err.status === 404 || err.message?.toLowerCase().includes("not found");
    const alreadyExists =
      err.status === 409 || err.message?.toLowerCase().includes("already exist");

    if (alreadyExists) {
      const resolved = await findRrset(
        zoneId,
        name,
        type,
        zoneName,
        connection
      );
      if (resolved) {
        return setRrsetRecords(
          zoneId,
          resolved.name,
          type,
          ttl,
          finalRecords,
          connection
        );
      }
    }

    if (!notFound) throw err;

    try {
      return await hetzner(
        `/zones/${zoneId}/rrsets`,
        {
          method: "POST",
          body: JSON.stringify({ name, type, ttl, records: finalRecords }),
        },
        connection
      );
    } catch (createErr) {
      const createExists =
        createErr.status === 409 ||
        createErr.message?.toLowerCase().includes("already exist");
      if (!createExists) throw createErr;

      const resolved = await findRrset(
        zoneId,
        name,
        type,
        zoneName,
        connection
      );
      if (!resolved) throw createErr;
      return setRrsetRecords(
        zoneId,
        resolved.name,
        type,
        ttl,
        finalRecords,
        connection
      );
    }
  }
}

async function getConnectionDetails(connection) {
  const candidate = {
    ...connection,
    apiKey: connection.apiKey || connection.apiToken,
  };
  if (!candidate.name || !["hetzner", "hostinger"].includes(candidate.provider)) {
    const err = new Error("Connection name and provider are required");
    err.status = 400;
    throw err;
  }
  if (!candidate.apiKey) {
    const err = new Error("API key is required");
    err.status = 400;
    throw err;
  }
  const zones = await listZones(candidate);
  const details = {
    provider: candidate.provider,
    zoneCount: zones.length,
    zones: zones.slice(0, 5).map((zone) => zone.name),
  };

  if (candidate.provider === "hetzner") {
    try {
      const servers = await fetchAllPages("/servers", "servers", candidate);
      details.serverCount = servers.length;
      details.servers = servers.slice(0, 5).map((server) => server.name);
    } catch (err) {
      details.serverCount = null;
      details.serverAccessError = err.message;
    }
  } else {
    details.activeDomainCount = zones.filter(
      (zone) => String(zone.status).toLowerCase() === "active"
    ).length;
  }

  return details;
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
    const connection = connectionForRequest(_req);
    const zones = await listZones(connection);
    res.json({ zones, provider: connection.provider });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/zones", async (req, res) => {
  try {
    const connection = connectionForRequest(req);
    if (connection.provider === "hostinger") {
      return res.status(405).json({
        error: "Hostinger creates DNS zones from domains in your account",
      });
    }
    const { name, ttl = 3600 } = req.body;
    if (!name) return res.status(400).json({ error: "Zone name is required" });

    const data = await hetzner(
      "/zones",
      {
        method: "POST",
        body: JSON.stringify({ name, mode: "primary", ttl }),
      },
      connection
    );
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/zones/:zoneId/rrsets", async (req, res) => {
  try {
    const rrsets = await listRrsets(
      connectionForRequest(req),
      req.params.zoneId
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

    const connection = connectionForRequest(req);
    const data =
      connection.provider === "hostinger"
        ? await upsertRrset(
            req.params.zoneId,
            { name, type, ttl, records },
            { connection, zoneName: req.params.zoneId }
          )
        : await hetzner(
            `/zones/${req.params.zoneId}/rrsets`,
            {
              method: "POST",
              body: JSON.stringify({ name, type, ttl, records }),
            },
            connection
          );
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

    const connection = connectionForRequest(req);
    const data = await upsertRrset(
      zoneId,
      { name, type, ttl, records },
      { connection, zoneName: zoneId }
    );
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete("/api/zones/:zoneId/rrsets/:name/:type", async (req, res) => {
  try {
    const { zoneId, name, type } = req.params;
    assertRrsetMutable(type);
    const connection = connectionForRequest(req);
    const data =
      connection.provider === "hostinger"
        ? await hostingerClient(connection).deleteRrset(zoneId, name, type)
        : await hetzner(
            `/zones/${zoneId}/rrsets/${encodeRrsetName(name)}/${type}`,
            { method: "DELETE" },
            connection
          );
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete("/api/zones/:zoneId", async (req, res) => {
  try {
    const connection = connectionForRequest(req);
    if (connection.provider === "hostinger") {
      return res.status(405).json({
        error: "Delete Hostinger domains from hPanel, not from DNS management",
      });
    }
    const data = await hetzner(
      `/zones/${req.params.zoneId}`,
      { method: "DELETE" },
      connection
    );
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/servers", async (_req, res) => {
  try {
    const connection = connectionForRequest(_req);
    if (connection.provider !== "hetzner") {
      return res.json({ servers: [], provider: connection.provider });
    }
    const servers = await fetchAllPages("/servers", "servers", connection);
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
    const connection = connectionForRequest(req);
    if (connection.provider !== "hetzner") {
      return res.status(405).json({
        error: "Reverse DNS management is currently available for Hetzner only",
      });
    }
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
      },
      connection
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

    const connection = connectionForRequest(req);
    const results = [];
    for (const rrset of records) {
      try {
        const data = await upsertRrset(zoneId, rrset, {
          zoneName: domain,
          mergeTxt: rrset.type === "TXT",
          replaceDmarc: rrset.name === "_dmarc",
          connection,
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
      error: "Configure the Poste.io connection in Settings",
    });
  }
  next();
}

async function applyRrsetsToZone(zoneId, domain, rrsets, connection) {
  const results = [];
  for (const rrset of rrsets) {
    try {
      const data = await upsertRrset(zoneId, rrset, {
        zoneName: domain,
        mergeTxt: Boolean(rrset.mergeTxt),
        replaceDmarc: Boolean(rrset.replaceDmarc),
        connection,
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

app.get("/api/poste/details", requirePoste, async (_req, res) => {
  try {
    const domains = await listPosteDomains();
    res.json({
      domainCount: domains.length,
      domains: domains.slice(0, 5).map((domain) => domain.name),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/poste/overview", requirePoste, async (_req, res) => {
  try {
    const connection = connectionForRequest(_req);
    const warnings = [];
    let posteDomains = [];
    let dnsZones = [];

    try {
      posteDomains = await listPosteDomains();
    } catch (err) {
      warnings.push(err.message);
    }

    try {
      dnsZones = await listZones(connection);
    } catch (err) {
      warnings.push(err.message);
    }

    if (!posteDomains.length && !dnsZones.length && warnings.length) {
      const status = warnings.some((message) => message.includes("401")) ? 401 : 502;
      return res.status(status).json({
        error: warnings.join(" · "),
        warnings,
      });
    }

    const zoneByName = new Map(dnsZones.map((zone) => [zone.name, zone.id]));
    const posteNames = new Set(posteDomains.map((domain) => domain.name));
    const domains = await Promise.all(
      posteDomains.map(async (domain) => {
        const mailboxes = await listMailboxesForDomain(domain.name);
        return {
          ...domain,
          mailboxCount: mailboxes.length,
          zoneId: zoneByName.get(domain.name) || null,
        };
      })
    );
    const unmanagedZones = dnsZones
      .filter((zone) => !posteNames.has(zone.name))
      .map((zone) => ({ name: zone.name, zoneId: zone.id }));
    const totalMailboxes = domains.reduce((sum, domain) => sum + domain.mailboxCount, 0);

    res.json({
      domains,
      unmanagedZones,
      totals: {
        posteDomains: domains.length,
        mailboxes: totalMailboxes,
        unlinked: domains.filter((domain) => !domain.zoneId).length,
        unmanagedZones: unmanagedZones.length,
      },
      provider: connection.provider,
      warnings,
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
      const rrsets = await listRrsets(connectionForRequest(req), zoneId);
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
      const rrsets = await listRrsets(connectionForRequest(req), zoneId);
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
    const connection = connectionForRequest(req);
    const rrsets = await listRrsets(connection, zoneId);
    const { gaps, toApply } = analyzeDnsGaps(domain, dns, rrsets, formatTxt);
    const dnsResults = await applyRrsetsToZone(
      zoneId,
      domain,
      toApply,
      connection
    );

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

    const address = decodeURIComponent(req.params.address);
    await resetPosteMailboxPassword(address, newPassword);

    let adminCredentialsUpdated = false;
    const posteSettings = getSettings().poste;
    if (
      posteSettings.adminEmail &&
      posteSettings.adminEmail.trim().toLowerCase() === address.trim().toLowerCase()
    ) {
      await updateSettings({ poste: { adminPassword: newPassword } });
      adminCredentialsUpdated = true;
    }

    res.json({
      ok: true,
      generatedPassword: password ? undefined : newPassword,
      adminCredentialsUpdated,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`PosteBridge running at http://localhost:${PORT}`);
});
