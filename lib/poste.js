import { buildMailRrsets } from "./mail-dns.js";

export function isPosteConfigured() {
  return Boolean(
    process.env.POSTE_BASE_URL?.trim() &&
      process.env.POSTE_ADMIN_EMAIL?.trim() &&
      process.env.POSTE_ADMIN_PASSWORD?.trim()
  );
}

export function getPosteConfig() {
  const baseUrl = process.env.POSTE_BASE_URL?.trim().replace(/\/$/, "");
  const email = process.env.POSTE_ADMIN_EMAIL?.trim();
  const password = process.env.POSTE_ADMIN_PASSWORD?.trim();

  if (!baseUrl || !email || !password) {
    const err = new Error(
      "POSTE_BASE_URL, POSTE_ADMIN_EMAIL, and POSTE_ADMIN_PASSWORD are required"
    );
    err.status = 503;
    throw err;
  }

  let mailHost = process.env.POSTE_MAIL_HOST?.trim();
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

export async function posteRequest(path, options = {}) {
  const { apiRoot, email, password } = getPosteConfig();
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
    const message =
      data?.message || data?.error || text || `Poste.io API error (${res.status})`;
    const err = new Error(typeof message === "string" ? message : `Poste.io API error (${res.status})`);
    err.status = res.status;
    err.details = data;
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
  const configured = process.env.POSTE_MAIL_HOST?.trim();
  if (configured) return configured;
  return `mail.${domain}`;
}

export async function getPosteMailbox(address) {
  return posteRequest(`/boxes/${encodeURIComponent(address)}`);
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

export async function resetPosteMailboxPassword(address, password) {
  return posteRequest(`/boxes/${encodeURIComponent(address)}`, {
    method: "PATCH",
    body: JSON.stringify({ passwordPlaintext: password }),
  });
}
