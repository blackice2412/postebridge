import { Resolver } from "dns/promises";

export const DNS_RESOLVERS = [
  { id: "google-primary", name: "Google Public DNS", region: "United States", servers: ["8.8.8.8"] },
  { id: "google-secondary", name: "Google Public DNS", region: "United States", servers: ["8.8.4.4"] },
  { id: "cloudflare-primary", name: "Cloudflare", region: "Global", servers: ["1.1.1.1"] },
  { id: "cloudflare-secondary", name: "Cloudflare", region: "Global", servers: ["1.0.0.1"] },
  { id: "quad9", name: "Quad9", region: "Global", servers: ["9.9.9.9"] },
  { id: "opendns-primary", name: "OpenDNS", region: "United States", servers: ["208.67.222.222"] },
  { id: "opendns-secondary", name: "OpenDNS", region: "United States", servers: ["208.67.220.220"] },
  { id: "comodo", name: "Comodo Secure DNS", region: "United States", servers: ["8.26.56.26"] },
  { id: "yandex", name: "Yandex DNS", region: "Russia", servers: ["77.88.8.8"] },
  { id: "cleanbrowsing", name: "CleanBrowsing", region: "United States", servers: ["185.228.168.9"] },
  { id: "level3", name: "Level3", region: "United States", servers: ["4.2.2.1"] },
  { id: "verisign", name: "Verisign", region: "United States", servers: ["64.6.64.6"] },
];

const SUPPORTED_TYPES = new Set(["A", "AAAA", "MX", "TXT", "NS", "CNAME"]);

function normalizeValue(type, value) {
  const v = String(value).trim().toLowerCase().replace(/\.$/, "");
  if (type === "TXT") return v.replace(/^"|"$/g, "");
  return v;
}

function normalizeValues(type, values) {
  return [...new Set(values.map((v) => normalizeValue(type, v)))].sort();
}

async function queryType(resolver, hostname, type) {
  const r = new Resolver();
  r.setServers(resolver.servers);
  const started = Date.now();
  try {
    let values;
    switch (type) {
      case "A": values = await r.resolve4(hostname); break;
      case "AAAA": values = await r.resolve6(hostname); break;
      case "MX": values = (await r.resolveMx(hostname)).map((e) => `${e.priority} ${e.exchange}`); break;
      case "TXT": values = (await r.resolveTxt(hostname)).map((c) => c.join("")); break;
      case "NS": values = await r.resolveNs(hostname); break;
      case "CNAME": values = await r.resolveCname(hostname); break;
      default: throw new Error(`Unsupported record type: ${type}`);
    }
    return { status: "ok", values: normalizeValues(type, values), latencyMs: Date.now() - started };
  } catch (err) {
    const code = err.code || "ERROR";
    const notFound = ["ENOTFOUND", "ENODATA", "NXDOMAIN"].includes(code);
    return { status: notFound ? "not_found" : "error", error: code, values: [], latencyMs: Date.now() - started };
  }
}

function compareExpected(type, values, expected) {
  if (!expected?.length) return null;
  const normExpected = normalizeValues(type, expected);
  const normActual = normalizeValues(type, values);
  if (!normExpected.length || !normActual.length) return normActual.length ? false : null;
  if (normExpected.length !== normActual.length) return false;
  return normExpected.every((v, i) => v === normActual[i]);
}

function summarizeType(checks) {
  const okChecks = checks.filter((c) => c.status === "ok");
  const errors = checks.filter((c) => c.status !== "ok").length;
  const valueGroups = new Map();
  for (const check of okChecks) {
    const key = check.values.join("||");
    valueGroups.set(key, (valueGroups.get(key) || 0) + 1);
  }
  let state = "failed";
  if (okChecks.length === checks.length && valueGroups.size === 1) state = "propagated";
  else if (okChecks.length > 0) state = valueGroups.size > 1 ? "partial" : "mixed";
  else if (errors > 0) state = "not_found";
  return { state, total: checks.length, ok: okChecks.length, errors, uniqueValues: valueGroups.size };
}

function buildCheck(resolver, hostname, type, result, expected) {
  return {
    resolver: resolver.name,
    resolverId: resolver.id,
    region: resolver.region,
    server: resolver.servers[0],
    type,
    ...result,
    match: compareExpected(type, result.values, expected[type]),
  };
}

export async function runDnsCheckStreaming({ hostname, types, expected = {}, onCheck }) {
  const cleanHost = String(hostname).trim().toLowerCase().replace(/\.$/, "");
  const recordTypes = (types || ["A"]).filter((t) => SUPPORTED_TYPES.has(t));
  if (!cleanHost) throw new Error("hostname is required");
  if (!recordTypes.length) throw new Error("At least one supported record type is required");

  const checks = [];
  await Promise.all(
    recordTypes.flatMap((type) =>
      DNS_RESOLVERS.map(async (resolver) => {
        const result = await queryType(resolver, cleanHost, type);
        const check = buildCheck(resolver, cleanHost, type, result, expected);
        checks.push(check);
        if (onCheck) await onCheck(check);
      })
    )
  );

  checks.sort((a, b) =>
    a.type !== b.type ? a.type.localeCompare(b.type) : a.resolver.localeCompare(b.resolver)
  );
  const summary = {};
  for (const type of recordTypes) {
    summary[type] = summarizeType(checks.filter((c) => c.type === type));
  }
  return {
    hostname: cleanHost,
    checkedAt: new Date().toISOString(),
    checks,
    summary,
    resolvers: DNS_RESOLVERS.length,
  };
}

export async function runDnsCheck(options) {
  return runDnsCheckStreaming(options);
}

export { SUPPORTED_TYPES, DNS_RESOLVERS, summarizeType };
