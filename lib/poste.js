import { buildMailRrsets } from "./mail-dns.js";

let configProvider = () => ({});

export function setPosteConfigProvider(provider) {
  configProvider = provider;
}

export function isPosteConfigured() {
  const config = configProvider();
  return Boolean(
    config.baseUrl?.trim() &&
      config.adminEmail?.trim() &&
      config.adminPassword?.trim()
  );
}

export function getPosteConfig(config = configProvider()) {
  const baseUrl = config.baseUrl?.trim().replace(/\/$/, "");
  const email = config.adminEmail?.trim();
  const password = config.adminPassword?.trim();

  if (!baseUrl || !email || !password) {
    const err = new Error(
      "Configure the Poste.io URL, admin email, and admin password in Settings"
    );
    err.status = 503;
    throw err;
  }

  let mailHost = config.mailHost?.trim();
  if (!mailHost) {
    try {
      mailHost = new URL(baseUrl).hostname;
    } catch {
      mailHost = baseUrl.replace(/^https?:\/\//, "").split("/")[0];
    }
  }

  return {
    apiRoot: `${baseUrl}/admin/api/v1`,
    email,
    password,
    mailHost,
    baseUrl,
  };
}

export async function verifyPosteConnection(config = configProvider()) {
  await posteRequest("/domains?page=1&paging=1", {}, config);
  return true;
}

export async function posteRequest(path, options = {}, config = configProvider()) {
  const { apiRoot, email, password } = getPosteConfig(config);
  const auth = Buffer.from(`${email}:${password}`).toString("base64");
  const res = await fetch(`${apiRoot}${path}`, {
    ...options,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (res.status === 204) return { ok: true };

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text || res.statusText };
  }

  if (!res.ok) {
    const rawMessage =
      data?.message || data?.error || text || `API error (${res.status})`;
    const message =
      typeof rawMessage === "string" ? rawMessage : `API error (${res.status})`;
    const err = new Error(`Poste.io: ${message}`);
    err.status = res.status;
    err.details = data;
    err.service = "poste";
    throw err;
  }

  return data;
}

function pemPublicKeyToDkim(pem) {
  return String(pem || "")
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/-----BEGIN RSA PUBLIC KEY-----/g, "")
    .replace(/-----END RSA PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
}

export function resolveMailHost(domain) {
  const configured = configProvider().mailHost?.trim();
  if (configured) return configured;
  return `mail.${domain}`;
}

export async function getPosteMailbox(address, config = configProvider()) {
  return posteRequest(`/boxes/${encodeURIComponent(address)}`, {}, config);
}

export async function getPosteDomain(name) {
  try {
    return await posteRequest(`/domains/${encodeURIComponent(name)}`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

export async function registerPosteDomain(name) {
  return posteRequest("/domains", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function ensurePosteDkim(domain) {
  let dkim;
  try {
    dkim = await posteRequest(`/domains/${encodeURIComponent(domain)}/dkim`);
  } catch (err) {
    if (err.status !== 404) throw err;
    dkim = null;
  }

  const selector = String(dkim?.selector || "").trim();
  const publicKey = String(dkim?.public || "").trim();
  if (!selector || !publicKey) {
    await posteRequest(`/domains/${encodeURIComponent(domain)}/dkim`, { method: "PUT" });
    dkim = await posteRequest(`/domains/${encodeURIComponent(domain)}/dkim`);
  }

  return dkim;
}

export async function fetchPosteDnsBundle(domain, { dmarcEmail } = {}) {
  const mailHost = resolveMailHost(domain);
  const mxTarget = mailHost.endsWith(".") ? mailHost : `${mailHost}.`;

  let dkimRecord = null;
  try {
    const dkim = await ensurePosteDkim(domain);
    const selector = String(dkim.selector || "").trim();
    const publicKey = pemPublicKeyToDkim(dkim.public);
    if (selector && publicKey) {
      dkimRecord = {
        host: `${selector}._domainkey.${domain}.`,
        type: "TXT",
        suggested: `k=rsa; p=${publicKey}`,
      };
    }
  } catch {
    dkimRecord = null;
  }

  const dmarcRua = dmarcEmail || `postmaster@${domain}`;
  const bundle = {
    mx: {
      host: `${domain}.`,
      type: "MX",
      suggested: `10 ${mxTarget}`,
    },
    spf: {
      host: `${domain}.`,
      type: "TXT",
      suggested: "v=spf1 mx ~all",
    },
    dkim: dkimRecord,
    dmarc: {
      host: `_dmarc.${domain}.`,
      type: "TXT",
      suggested: `v=DMARC1; p=none; rua=mailto:${dmarcRua}`,
    },
    autoconfig: {
      host: `autoconfig.${domain}.`,
      type: "CNAME",
      suggested: mxTarget,
    },
    autodiscover: {
      host: `autodiscover.${domain}.`,
      type: "CNAME",
      suggested: mxTarget,
    },
  };

  return bundle;
}

export function buildPosteRrsets(zoneName, bundle, formatTxt) {
  return buildMailRrsets(zoneName, bundle, formatTxt);
}

export async function listPosteDomains() {
  const domains = [];
  let page = 1;

  while (true) {
    const data = await posteRequest(`/domains?page=${page}&paging=50`);
    domains.push(...(data.results || []));
    if (!data.last_page || page >= data.last_page) break;
    page += 1;
  }

  return domains.map((domain) => ({
    name: domain.name,
    created: domain.created,
    updated: domain.updated,
    disabled: Boolean(domain.disabled),
    forward: Boolean(domain.forward),
  }));
}

export function getPosteUrls() {
  const { baseUrl } = getPosteConfig();
  return {
    webmailUrl: `${baseUrl}/webmail`,
    adminUrl: `${baseUrl}/admin`,
  };
}

export async function getPosteDomainQuota(domain) {
  try {
    return await posteRequest(`/domains/${encodeURIComponent(domain)}/quota`);
  } catch {
    return null;
  }
}

export async function listMailboxesForDomain(domain) {
  const mailboxes = [];
  let page = 1;

  while (true) {
    const data = await posteRequest(`/boxes?page=${page}&paging=50`);
    const pageResults = (data.results || []).filter((box) =>
      String(box.address || "").toLowerCase().endsWith(`@${domain.toLowerCase()}`)
    );
    for (const box of pageResults) {
      mailboxes.push({
        address: box.address,
        name: box.name || "",
        disabled: Boolean(box.disabled),
        domainAdmin: Boolean(box.domain_admin),
        fullAdmin: Boolean(box.super_admin),
        created: box.created,
        updated: box.updated,
      });
    }
    if (!data.last_page || page >= data.last_page) break;
    page += 1;
  }

  return mailboxes;
}

export async function createPosteMailbox({ address, password, name }) {
  return posteRequest("/boxes", {
    method: "POST",
    body: JSON.stringify({
      email: address,
      passwordPlaintext: password,
      name: name || "",
    }),
  });
}

export async function deletePosteMailbox(address) {
  return posteRequest(`/boxes/${encodeURIComponent(address)}`, {
    method: "DELETE",
  });
}

export async function resetPosteMailboxPassword(address, password, config = configProvider()) {
  return posteRequest(`/boxes/${encodeURIComponent(address)}`, {
    method: "PATCH",
    body: JSON.stringify({ passwordPlaintext: password }),
  }, config);
}

function isConfigComplete(config) {
  return Boolean(
    config.baseUrl?.trim() &&
      config.adminEmail?.trim() &&
      config.adminPassword?.trim()
  );
}

export async function syncAdminMailboxPassword(oldConfig, newConfig) {
  const address = newConfig.adminEmail?.trim();
  const newPassword = newConfig.adminPassword?.trim();
  const oldPassword = oldConfig.adminPassword?.trim();

  if (!address || !newPassword || newPassword === oldPassword || !isConfigComplete(oldConfig)) {
    return { synced: false };
  }

  try {
    await getPosteMailbox(address, oldConfig);
  } catch (err) {
    if (err.status === 404) return { synced: false };
    throw err;
  }

  await resetPosteMailboxPassword(address, newPassword, oldConfig);
  return { synced: true, address };
}
