export function hostToRrsetName(host, zoneName) {
  const normalized = String(host || "").replace(/\.$/, "").toLowerCase();
  const zone = zoneName.toLowerCase();
  if (!normalized || normalized === zone) return "@";
  if (normalized.endsWith(`.${zone}`)) {
    const label = normalized.slice(0, -(zone.length + 1));
    return label || "@";
  }
  return normalized;
}

export function buildMailRrsets(zoneName, bundle, formatTxt) {
  const rrsets = [];
  const fqdn = (value) => (value.endsWith(".") ? value : `${value}.`);

  if (bundle.mx?.suggested) {
    rrsets.push({
      name: "@",
      type: "MX",
      ttl: 3600,
      records: [{ value: bundle.mx.suggested, comment: "Mail MX" }],
    });
  }

  if (bundle.spf?.suggested) {
    rrsets.push({
      name: "@",
      type: "TXT",
      ttl: 3600,
      records: [{ value: formatTxt(bundle.spf.suggested), comment: "SPF" }],
      mergeTxt: true,
    });
  }

  if (bundle.dkim?.suggested) {
    rrsets.push({
      name: hostToRrsetName(bundle.dkim.host, zoneName),
      type: "TXT",
      ttl: 3600,
      records: [{ value: formatTxt(bundle.dkim.suggested), comment: "DKIM" }],
    });
  }

  if (bundle.dmarc?.suggested) {
    rrsets.push({
      name: hostToRrsetName(bundle.dmarc.host, zoneName),
      type: "TXT",
      ttl: 3600,
      records: [{ value: formatTxt(bundle.dmarc.suggested), comment: "DMARC" }],
      replaceDmarc: true,
    });
  }

  for (const [label, record] of [
    ["autoconfig", bundle.autoconfig],
    ["autodiscover", bundle.autodiscover],
  ]) {
    if (record?.suggested) {
      rrsets.push({
        name: label,
        type: "CNAME",
        ttl: 3600,
        records: [{ value: fqdn(record.suggested), comment: `${label}` }],
      });
    }
  }

  return rrsets;
}
