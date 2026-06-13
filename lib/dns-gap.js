import { buildMailRrsets, hostToRrsetName } from "./mail-dns.js";
import { parseTxtContent } from "./txt-dns.js";

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

function normalizeTxt(value) {
  return parseTxtContent(value).toLowerCase();
}

function normalizeMx(value) {
  const parts = String(value).trim().replace(/\s+/g, " ").toLowerCase().split(" ");
  const priority = parts.shift() || "0";
  const host = parts.join(" ").replace(/\.$/, "");
  return `${priority} ${host}`;
}

function normalizeCname(value) {
  return String(value).trim().replace(/\.$/, "").toLowerCase();
}

function findRrsets(rrsets, name, type, zoneName) {
  return rrsets.filter(
    (rrset) => rrset.type === type && rrsetNamesEquivalent(rrset.name, name, zoneName)
  );
}

function flattenValues(rrsetList) {
  return rrsetList.flatMap((rrset) => rrset.records.map((record) => record.value));
}

function dkimPublicKey(value) {
  const match = normalizeTxt(value).match(/p=([a-z0-9+/=_-]+)/i);
  return match ? match[1] : null;
}

function gapEntry({ status, desired, existing = [], label, host, type }) {
  return { status, desired, existing, label, host, type };
}

export function analyzeDnsGaps(zoneName, bundle, rrsets, formatTxt) {
  const gaps = {};
  const fullRrsets = buildMailRrsets(zoneName, bundle, formatTxt);
  const rrsetByKey = new Map(fullRrsets.map((rrset) => [`${rrset.name}:${rrset.type}`, rrset]));

  if (bundle.mx?.suggested) {
    const desiredNorm = normalizeMx(bundle.mx.suggested);
    const existing = flattenValues(findRrsets(rrsets, "@", "MX", zoneName));
    const existingNorms = existing.map(normalizeMx);
    const status = existingNorms.includes(desiredNorm)
      ? "present"
      : existing.length
        ? "different"
        : "missing";
    gaps.mx = gapEntry({
      status,
      desired: bundle.mx.suggested,
      existing,
      label: "MX",
      host: zoneName,
      type: "MX",
    });
  }

  if (bundle.spf?.suggested) {
    const desired = normalizeTxt(bundle.spf.suggested);
    const apexTxt = flattenValues(findRrsets(rrsets, "@", "TXT", zoneName));
    const spfValues = apexTxt.filter((value) => normalizeTxt(value).startsWith("v=spf1"));
    const status = spfValues.some((value) => normalizeTxt(value) === desired)
      ? "present"
      : spfValues.length
        ? "different"
        : "missing";
    gaps.spf = gapEntry({
      status,
      desired: bundle.spf.suggested,
      existing: spfValues,
      label: "SPF",
      host: zoneName,
      type: "TXT",
    });
  }

  if (bundle.dkim?.suggested) {
    const name = hostToRrsetName(bundle.dkim.host, zoneName);
    const desiredKey = dkimPublicKey(bundle.dkim.suggested);
    const existingRrsets = findRrsets(rrsets, name, "TXT", zoneName);
    const existing = flattenValues(existingRrsets);
    const existingKeys = existing.map(dkimPublicKey).filter(Boolean);
    const status =
      desiredKey && existingKeys.includes(desiredKey)
        ? "present"
        : existing.length
          ? "different"
          : "missing";
    gaps.dkim = gapEntry({
      status,
      desired: bundle.dkim.suggested,
      existing,
      label: "DKIM",
      host: bundle.dkim.host?.replace(/\.$/, "") || `${name}.${zoneName}`,
      type: "TXT",
    });
  }

  if (bundle.dmarc?.suggested) {
    const name = hostToRrsetName(bundle.dmarc.host, zoneName);
    const desired = normalizeTxt(bundle.dmarc.suggested);
    const existing = flattenValues(findRrsets(rrsets, name, "TXT", zoneName));
    const dmarcValues = existing.filter((value) => normalizeTxt(value).startsWith("v=dmarc1"));
    const status = dmarcValues.some((value) => normalizeTxt(value) === desired)
      ? "present"
      : dmarcValues.length
        ? "different"
        : "missing";
    gaps.dmarc = gapEntry({
      status,
      desired: bundle.dmarc.suggested,
      existing: dmarcValues,
      label: "DMARC",
      host: bundle.dmarc.host?.replace(/\.$/, "") || `_dmarc.${zoneName}`,
      type: "TXT",
    });
  }

  for (const key of ["autoconfig", "autodiscover"]) {
    const record = bundle[key];
    if (!record?.suggested) continue;
    const desired = normalizeCname(record.suggested);
    const existing = flattenValues(findRrsets(rrsets, key, "CNAME", zoneName));
    const existingNorms = existing.map(normalizeCname);
    const status = existingNorms.includes(desired)
      ? "present"
      : existing.length
        ? "different"
        : "missing";
    gaps[key] = gapEntry({
      status,
      desired: record.suggested,
      existing,
      label: key,
      host: `${key}.${zoneName}`,
      type: "CNAME",
    });
  }

  const toApply = [];
  for (const [recordKey, gap] of Object.entries(gaps)) {
    if (gap.status === "present") continue;
    const rrsetKey =
      recordKey === "spf"
        ? "@:TXT"
        : recordKey === "mx"
          ? "@:MX"
          : recordKey === "dkim"
            ? `${hostToRrsetName(bundle.dkim.host, zoneName)}:TXT`
            : recordKey === "dmarc"
              ? `${hostToRrsetName(bundle.dmarc.host, zoneName)}:TXT`
              : `${recordKey}:CNAME`;
    const rrset = rrsetByKey.get(rrsetKey);
    if (rrset) toApply.push(rrset);
  }

  return { gaps, toApply };
}
