const state = {
  zones: [],
  servers: [],
  rrsets: [],
  selectedZoneId: null,
  editingRecord: null,
  activeView: "records",
  poste: {
    configured: false,
    registered: false,
    dns: null,
    gaps: null,
    toApply: [],
    mailboxes: [],
    mailHost: null,
    webmailUrl: null,
    adminUrl: null,
    overview: [],
    unmanagedZones: [],
    totals: null,
    dnsComplete: false,
  },
};
const $ = (sel) => document.querySelector(sel);
const zoneSelect = $("#zoneSelect");
const zoneMeta = $("#zoneMeta");
const recordsBody = $("#recordsBody");
const toast = $("#toast");
const recordModal = $("#recordModal");
const zoneModal = $("#zoneModal");

const VIEW_META = {
  records: { title: "Zones & Records", subtitle: "Manage Hetzner DNS zones and record sets" },
  propagation: { title: "Propagation Check", subtitle: "Verify global DNS propagation across public resolvers" },
  email: { title: "Email", subtitle: "DNS and mailboxes for the selected zone only" },
  mailman: { title: "Mail Manager", subtitle: "Overview of all Poste.io domains and fleet actions" },
  rdns: { title: "Reverse DNS", subtitle: "Set PTR records on Hetzner servers for outbound mail" },
};

const SwalToast = Swal.mixin({
  toast: true,
  position: "top-end",
  showConfirmButton: false,
  timer: 4000,
  timerProgressBar: true,
  background: "#111827",
  color: "#e8ecf4",
});

const swalBase = {
  background: "#111827",
  color: "#f1f5f9",
  confirmButtonColor: "#3b82f6",
  cancelButtonColor: "#2d3a4f",
  customClass: { popup: "swal-dns" },
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function showToast(message, type = "success") {
  SwalToast.fire({ icon: type === "error" ? "error" : "success", title: message });
}

async function confirmDelete(title, html) {
  const result = await Swal.fire({
    ...swalBase,
    title,
    html,
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: "Delete",
    cancelButtonText: "Cancel",
    reverseButtons: true,
    focusCancel: true,
    confirmButtonColor: "#f25c54",
  });
  return result.isConfirmed;
}

async function confirmZoneDelete(zoneName) {
  const result = await Swal.fire({
    ...swalBase,
    title: "Delete zone?",
    html: `This permanently removes <strong>${esc(zoneName)}</strong> and all DNS records.`,
    icon: "warning",
    input: "text",
    inputLabel: `Type "${zoneName}" to confirm`,
    inputPlaceholder: zoneName,
    showCancelButton: true,
    confirmButtonText: "Delete zone",
    cancelButtonText: "Cancel",
    reverseButtons: true,
    focusCancel: true,
    confirmButtonColor: "#f25c54",
    inputValidator: (value) =>
      value === zoneName ? undefined : "Zone name does not match",
  });
  return result.isConfirmed;
}

function selectedZone() {
  return state.zones.find((z) => String(z.id) === String(state.selectedZoneId));
}

const PROTECTED_TYPES = new Set(["NS", "SOA"]);

function isProtectedRecord(type) {
  return PROTECTED_TYPES.has(type);
}

function displayName(name, zoneName) {
  return name === "@" ? zoneName : `${name}.${zoneName}`;
}

function formatValues(rrset) {
  return rrset.records.map((r) => r.value).join("\n");
}

function parseValues(type, raw) {
  return raw.split("\n").map((l) => l.trim()).filter(Boolean).map((value) => {
    if (type === "TXT" && !value.startsWith('"')) return { value: `"${value}"` };
    if (["CNAME", "MX", "NS"].includes(type) && !value.endsWith(".")) return { value: `${value}.` };
    return { value };
  });
}

function renderZoneMeta(zone) {
  if (!zone) { zoneMeta.hidden = true; return; }
  const delegation = zone.authoritative_nameservers?.delegation_status || "unknown";
  const badgeClass = delegation === "valid" ? "badge-ok" : "badge-warn";
  zoneMeta.hidden = false;
  zoneMeta.innerHTML = `<span>${zone.record_count} records</span><span>TTL: ${zone.ttl}s</span><span>Delegation: <span class="badge ${badgeClass}">${delegation}</span></span>`;
}

function renderRecords() {
  const zone = selectedZone();
  if (!zone) {
    recordsBody.innerHTML = '<tr><td colspan="5" class="empty">Select a zone</td></tr>';
    return;
  }
  if (!state.rrsets.length) {
    recordsBody.innerHTML = '<tr><td colspan="5" class="empty">No records yet</td></tr>';
    return;
  }
  const sorted = [...state.rrsets].sort((a, b) => {
    if (a.name === b.name) return a.type.localeCompare(b.type);
    if (a.name === "@") return -1;
    if (b.name === "@") return 1;
    return a.name.localeCompare(b.name);
  });
  recordsBody.innerHTML = sorted.map((rrset) => {
    const values = rrset.records.map((r) => esc(r.value)).join("<br>");
    const prot = rrset.protection?.change || isProtectedRecord(rrset.type);
    const lockLabel = isProtectedRecord(rrset.type) ? "System" : prot ? "Protected" : "";
    const actions = prot
      ? `<span class="locked-label" title="${lockLabel} record">${lockLabel || "Locked"}</span>`
      : `<button class="btn btn-secondary btn-sm check-btn" type="button">Check</button>
         <button class="btn btn-secondary btn-sm edit-btn" type="button">Edit</button>
         <button class="btn btn-danger btn-sm delete-btn" type="button">Delete</button>`;
    return `<tr data-name="${escAttr(rrset.name)}" data-type="${rrset.type}">
      <td class="name-cell">${esc(displayName(rrset.name, zone.name))}</td>
      <td><span class="type-pill ${isProtectedRecord(rrset.type) ? "type-pill-system" : ""}">${rrset.type}</span></td><td>${rrset.ttl}</td>
      <td class="value-cell">${values}</td>
      <td class="actions">${actions}</td></tr>`;
  }).join("");
}

function renderZoneSelect() {
  const prev = state.selectedZoneId;
  zoneSelect.innerHTML = '<option value="">Select a zone…</option>' + state.zones.map((z) =>
    `<option value="${z.id}" ${String(z.id) === String(prev) ? "selected" : ""}>${z.name}</option>`).join("");
}

function renderServerSelects() {
  const mailIpv4 = $("#mailIpv4");
  const rdnsServer = $("#rdnsServer");
  mailIpv4.innerHTML = '<option value="">Select server IP…</option>' + state.servers.filter((s) => s.ipv4)
    .map((s) => `<option value="${s.ipv4}">${s.name} — ${s.ipv4}</option>`).join("");
  rdnsServer.innerHTML = '<option value="">Select server…</option>' + state.servers.filter((s) => s.ipv4)
    .map((s) => `<option value="${s.id}" data-ip="${s.ipv4}" data-ptr="${escAttr(s.dns_ptr || "")}">${s.name} — ${s.ipv4}</option>`).join("");
}

function updateMailPreview() {
  const zone = selectedZone();
  const preview = $("#mailPreview");
  if (!zone) { preview.textContent = "Select a zone first"; return; }
  const mailHost = $("#mailHost").value.trim() || "mail";
  const ipv4 = $("#mailIpv4Manual").value.trim() || $("#mailIpv4").value;
  const priority = $("#mxPriority").value || "10";
  const spf = $("#spfRecord").value.trim() || "v=spf1 mx ~all";
  const dmarcEmail = $("#dmarcEmail").value.trim() || `postmaster@${zone.name}`;
  const mailFqdn = `${mailHost}.${zone.name}`;
  preview.innerHTML = [
    ipv4 ? `<div class="line-ok">A  ${mailFqdn} → ${ipv4}</div>` : "",
    `<div class="line-ok">MX  ${zone.name} → ${priority} ${mailFqdn}.</div>`,
    `<div class="line-ok">TXT ${zone.name} → ${spf}</div>`,
    `<div class="line-ok">TXT _dmarc.${zone.name} → v=DMARC1; p=none; rua=mailto:${dmarcEmail}</div>`,
    `<div>PTR ${ipv4 || "?"} → ${mailFqdn}</div>`,
  ].join("");
}

function syncCheckHostname() {
  const zone = selectedZone();
  const input = $("#checkHostname");
  if (!input) return;
  if (!input.value || input.dataset.autofill === "true") {
    input.value = zone?.name || "";
    input.dataset.autofill = zone ? "true" : "false";
  }
}

function switchView(view) {
  state.activeView = view;
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((el) => {
    el.classList.toggle("active", el.id === `view-${view}`);
  });
  const meta = VIEW_META[view];
  $("#viewTitle").textContent = meta.title;
  $("#viewSubtitle").textContent = meta.subtitle;
  if (view === "propagation") syncCheckHostname();
  if (view === "email") {
    renderEmailView();
    loadPosteForZone().catch((err) => showToast(err.message, "error"));
  }
  if (view === "mailman") {
    loadPosteOverview().catch((err) => showToast(err.message, "error"));
  }
}

function getSelectedCheckTypes() {
  return [...document.querySelectorAll("#typeChips input:checked")].map((el) => el.value);
}

function buildExpectedMap(hostname, types) {
  const zone = selectedZone();
  if (!zone || !$("#compareZone").checked) return {};

  const expected = {};
  for (const type of types) {
    const matches = state.rrsets.filter((r) => {
      if (r.type !== type) return false;
      const fqdn = displayName(r.name, zone.name).toLowerCase();
      return fqdn === hostname.toLowerCase();
    });
    if (matches.length) {
      expected[type] = matches.flatMap((r) => r.records.map((rec) => rec.value));
    }
  }
  return expected;
}

function propagationStatusBadge(stateName) {
  const map = {
    propagated: ["badge-ok", "Propagated"],
    partial: ["badge-warn", "Partial"],
    mixed: ["badge-warn", "Mixed"],
    not_found: ["badge-danger", "Not found"],
    failed: ["badge-danger", "Failed"],
  };
  const [cls, label] = map[stateName] || ["badge-info", stateName];
  return `<span class="badge ${cls}">${label}</span>`;
}

function renderPropagationSummary(data) {
  const panel = $("#propSummary");
  const types = Object.keys(data.summary);
  if (!types.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  panel.innerHTML = types.map((type) => {
    const s = data.summary[type];
    return `<div class="summary-card">
      <div class="label">${type} record</div>
      <div class="value" style="margin-top:8px">${propagationStatusBadge(s.state)}</div>
      <div class="detail">${s.ok}/${s.total} resolvers · ${s.uniqueValues} unique value set(s)</div>
    </div>`;
  }).join("") + `<div class="summary-card">
    <div class="label">Resolvers checked</div>
    <div class="value">${data.resolvers}</div>
    <div class="detail">Public DNS providers worldwide</div>
  </div>`;
}

function renderPropagationResults(data) {
  const panel = $("#propResultsPanel");
  const body = $("#propResultsBody");
  panel.hidden = false;
  $("#propCheckedAt").textContent = `Checked ${new Date(data.checkedAt).toLocaleString()}`;

  body.innerHTML = data.checks.map((row) => {
    const values = row.values?.length ? row.values.map(esc).join("<br>") : `<span class="muted">${esc(row.error || row.status)}</span>`;
    const status = row.status === "ok"
      ? `<span class="badge badge-ok">OK</span>`
      : row.status === "not_found"
        ? `<span class="badge badge-warn">NXDOMAIN</span>`
        : `<span class="badge badge-danger">Error</span>`;
    const zoneMatch = row.match === null
      ? "—"
      : row.match
        ? `<span class="badge badge-ok">Match</span>`
        : `<span class="badge badge-danger">Mismatch</span>`;
    return `<tr>
      <td>${esc(row.resolver)}<div class="meta-text mono">${esc(row.server)}</div></td>
      <td>${esc(row.region)}</td>
      <td><span class="type-pill">${row.type}</span></td>
      <td>${status}</td>
      <td class="value-cell">${values}</td>
      <td class="mono">${row.latencyMs}ms</td>
      <td>${zoneMatch}</td>
    </tr>`;
  }).join("");
}

async function runPropagationCheck(e) {
  e?.preventDefault();
  const hostname = $("#checkHostname").value.trim();
  const types = getSelectedCheckTypes();
  if (!hostname) { showToast("Enter a hostname", "error"); return; }
  if (!types.length) { showToast("Select at least one record type", "error"); return; }

  const btn = $("#runCheckBtn");
  btn.disabled = true;
  btn.textContent = "Checking…";
  try {
    const data = await api("/api/dns-check", {
      method: "POST",
      body: JSON.stringify({
        hostname,
        types,
        expected: buildExpectedMap(hostname, types),
      }),
    });
    renderPropagationSummary(data);
    renderPropagationResults(data);
    showToast(`Checked ${hostname} across ${data.resolvers} resolvers`);
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Run propagation check";
  }
}

function openPropagationForRecord(name, type) {
  const zone = selectedZone();
  if (!zone) return;
  const hostname = displayName(name, zone.name);
  switchView("propagation");
  const input = $("#checkHostname");
  input.value = hostname;
  input.dataset.autofill = "false";
  document.querySelectorAll("#typeChips input").forEach((el) => {
    el.checked = el.value === type;
  });
  runPropagationCheck();
}

function syncPosteDmarcEmail() {
  const zone = selectedZone();
  const input = $("#posteDmarcEmail");
  if (!input || !zone) return;
  if (!input.value || input.dataset.autofill === "true") {
    input.value = `postmaster@${zone.name}`;
    input.dataset.autofill = "true";
  }
}

function syncMailboxPasswordField() {
  const generate = $("#mailboxGenPass").checked;
  const pass = $("#mailboxPassword");
  pass.disabled = generate;
  pass.required = !generate;
  if (generate) pass.value = "";
}

function computeDnsComplete(gaps) {
  if (!gaps) return false;
  return Object.values(gaps).every((gap) => gap.status === "present");
}

function pendingDnsCount(gaps) {
  if (!gaps) return 0;
  return Object.values(gaps).filter((gap) => gap.status !== "present").length;
}

function renderEmailView() {
  const zone = selectedZone();
  const configured = state.poste.configured;
  const noZone = $("#emailNoZone");
  const workspace = $("#emailWorkspace");

  if (!configured) {
    noZone.hidden = true;
    workspace.hidden = false;
    return;
  }

  if (!zone) {
    noZone.hidden = false;
    workspace.hidden = true;
    return;
  }

  noZone.hidden = true;
  workspace.hidden = false;
  const title = $("#emailDomainTitle");
  if (title) title.textContent = `Email — ${zone.name}`;
}

async function openEmailForZone(zoneId, domainName) {
  zoneSelect.value = zoneId;
  state.selectedZoneId = zoneId;
  renderZoneMeta(selectedZone());
  syncCheckHostname();
  syncPosteDmarcEmail();
  await loadRecords();
  updateMailPreview();
  await loadPosteForZone();
  switchView("email");
  showToast(`Managing email for ${domainName}`);
}

function setActionButtons() {
  const zone = selectedZone();
  const hasZone = !!state.selectedZoneId;
  const posteReady = hasZone && state.poste.configured;
  const posteConfigured = state.poste.configured;
  const dnsComplete = computeDnsComplete(state.poste.gaps);
  const registered = state.poste.registered;
  const pending = pendingDnsCount(state.poste.gaps);

  $("#addRecordBtn").disabled = !hasZone;
  $("#applyMailBtn").disabled = !hasZone;
  $("#applyRdnsBtn").disabled = !$("#rdnsServer").value;

  const applyBtn = $("#posteApplyDnsBtn");
  applyBtn.disabled = !posteReady || dnsComplete;
  applyBtn.textContent = dnsComplete
    ? "DNS configured"
    : pending
      ? `Apply DNS (${pending})`
      : "Apply DNS to zone";
  applyBtn.title = dnsComplete
    ? "All mail DNS records are already configured in Hetzner"
    : !posteReady
      ? "Select a zone first"
      : `Apply ${pending} pending DNS record(s) including DKIM`;

  const registerBtn = $("#posteRegisterBtn");
  registerBtn.disabled = !posteReady || registered;
  registerBtn.textContent = registered ? "Domain registered" : "Register domain";
  registerBtn.title = registered
    ? "This domain is already registered on Poste.io"
    : !posteReady
      ? "Select a zone first"
      : "Add this domain to your Poste.io server";

  const fullBtn = $("#posteFullSetupBtn");
  fullBtn.disabled = !posteReady || (dnsComplete && registered);
  fullBtn.title =
    dnsComplete && registered
      ? "DNS and Poste.io registration are already complete"
      : !posteReady
        ? "Select a zone first"
        : "Apply pending DNS records and register on Poste.io";

  $("#posteRefreshBtn").disabled = !posteReady;
  $("#createMailboxBtn").disabled = !posteReady || !registered;
  $("#createMailboxBtn").title = !registered && posteReady
    ? "Register the domain on Poste.io before creating mailboxes"
    : "";
  $("#posteWebmailBtn").disabled = !posteConfigured || !state.poste.webmailUrl;
  $("#posteAdminBtn").disabled = !posteConfigured || !state.poste.adminUrl;
  $("#posteHealthBtn").disabled = !posteReady;
  $("#posteOverviewRefreshBtn").disabled = !posteConfigured;

  renderEmailView();

  const deleteBtn = $("#deleteZoneBtn");
  deleteBtn.disabled = !hasZone || zone?.protection?.delete;
  deleteBtn.title = zone?.protection?.delete
    ? "Zone delete protection is enabled"
    : hasZone
      ? `Delete zone ${zone.name}`
      : "Select a zone to delete";
}

function posteDmarcEmail() {
  const zone = selectedZone();
  return $("#posteDmarcEmail").value.trim() || `postmaster@${zone?.name || "example.com"}`;
}

function gapStatusBadge(status) {
  const map = {
    present: ["badge-ok", "Configured"],
    missing: ["badge-warn", "Missing"],
    different: ["badge-danger", "Needs update"],
  };
  const [cls, label] = map[status] || ["badge-info", status];
  return `<span class="badge ${cls}">${label}</span>`;
}

function renderPosteDnsPreview() {
  const preview = $("#posteDnsPreview");
  const zone = selectedZone();
  if (!zone) {
    preview.textContent = "Select a zone first";
    return;
  }
  if (!state.poste.configured) {
    preview.textContent = "Poste.io credentials not configured";
    return;
  }

  const gaps = state.poste.gaps;
  if (!gaps) {
    preview.textContent = "Loading Poste.io DNS records…";
    return;
  }

  const lines = [];
  if (state.poste.mailHost) {
    lines.push(`<div class="hint small">Mail host: ${esc(state.poste.mailHost)}</div>`);
  }

  for (const key of ["mx", "spf", "dkim", "dmarc", "autoconfig", "autodiscover"]) {
    const gap = gaps[key];
    if (!gap) continue;
    const existing = gap.existing?.length
      ? `<div class="hint small">Current: ${esc(gap.existing.join(" | "))}</div>`
      : "";
    const action = gap.status === "present"
      ? ""
      : `<div class="hint small">Will apply: ${esc(truncateDns(gap.desired, 120))}</div>`;
    const copyBtn = gap.desired
      ? `<button class="btn btn-ghost btn-sm copy-dns-btn" type="button" data-copy="${escAttr(gap.desired)}" title="Copy record value">Copy</button>`
      : "";
    lines.push(`<div class="dns-line">${gapStatusBadge(gap.status)} <strong>${esc(gap.label)}</strong> ${esc(gap.host)} ${copyBtn}${existing}${action}</div>`);
  }

  const missingCount = Object.values(gaps).filter((gap) => gap.status !== "present").length;
  if (!missingCount) {
    lines.push('<div class="hint small">All recommended mail DNS records are already configured.</div>');
  } else {
    lines.push(`<div class="hint small">${missingCount} record(s) will be added or updated on apply.</div>`);
  }

  preview.innerHTML = lines.join("");
}

function renderPosteBadge() {
  const badge = $("#posteDomainBadge");
  const dnsBadge = $("#posteDnsBadge");
  const hint = $("#posteActiveZoneHint");
  const zone = selectedZone();
  if (!zone || !state.poste.configured) {
    badge.hidden = true;
    if (dnsBadge) dnsBadge.hidden = true;
    if (hint) hint.textContent = "";
    return;
  }
  badge.hidden = false;
  if (dnsBadge) {
    const dnsComplete = computeDnsComplete(state.poste.gaps);
    dnsBadge.hidden = false;
    if (dnsComplete) {
      dnsBadge.textContent = "DNS complete";
      dnsBadge.className = "badge badge-ok";
    } else {
      const pending = pendingDnsCount(state.poste.gaps);
      dnsBadge.textContent = `${pending} DNS pending`;
      dnsBadge.className = "badge badge-warn";
    }
  }
  if (hint) hint.textContent = `Mail host: ${state.poste.mailHost || "—"}`;
  if (state.poste.registered) {
    badge.textContent = "Registered on Poste.io";
    badge.className = "badge badge-ok";
  } else {
    badge.textContent = "Not registered on Poste.io";
    badge.className = "badge badge-warn";
  }
}

function getFilteredOverview() {
  const query = ($("#mailmanSearch")?.value || "").trim().toLowerCase();
  if (!query) return state.poste.overview;
  return state.poste.overview.filter((domain) => domain.name.toLowerCase().includes(query));
}

function renderMailManagerStats() {
  const panel = $("#mailmanStats");
  const totals = state.poste.totals;
  if (!panel || !totals) {
    if (panel) panel.hidden = true;
    return;
  }
  panel.hidden = false;
  panel.innerHTML = [
    statCard("Poste domains", totals.posteDomains),
    statCard("Total mailboxes", totals.mailboxes),
    statCard("Unlinked domains", totals.unlinked),
    statCard("Zones without Poste", totals.unmanagedZones),
  ].join("");
}

function statCard(label, value) {
  return `<div class="summary-card"><span class="label">${esc(label)}</span><div class="value">${esc(String(value))}</div></div>`;
}

function renderUnmanagedZones() {
  const panel = $("#unmanagedZonesPanel");
  const body = $("#unmanagedZonesBody");
  if (!body) return;
  const zones = state.poste.unmanagedZones || [];
  if (!zones.length) {
    if (panel) panel.hidden = true;
    return;
  }
  if (panel) panel.hidden = false;
  body.innerHTML = zones.map((zone) => `
    <tr data-zone-id="${escAttr(zone.hetznerZoneId)}" data-domain="${escAttr(zone.name)}">
      <td class="name-cell">${esc(zone.name)}</td>
      <td class="actions">
        <button class="btn btn-primary btn-sm setup-email-btn" type="button">Set up email</button>
      </td>
    </tr>
  `).join("");
}

function renderPosteOverview() {
  const body = $("#posteDomainsBody");
  if (!state.poste.configured) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Poste.io is not configured</td></tr>';
    renderMailManagerStats();
    renderUnmanagedZones();
    return;
  }

  const domains = getFilteredOverview();
  if (!domains.length) {
    body.innerHTML = state.poste.overview.length
      ? '<tr><td colspan="5" class="empty">No domains match your search</td></tr>'
      : '<tr><td colspan="5" class="empty">No domains registered on Poste.io yet</td></tr>';
  } else {
    body.innerHTML = domains.map((domain) => {
      const zoneLink = domain.hetznerZoneId
        ? '<span class="badge badge-ok">Linked</span>'
        : '<span class="badge badge-warn">No zone</span>';
      const status = domain.disabled
        ? '<span class="badge badge-warn">Disabled</span>'
        : '<span class="badge badge-ok">Active</span>';
      return `<tr data-domain="${escAttr(domain.name)}" data-zone-id="${escAttr(domain.hetznerZoneId || "")}">
        <td class="name-cell">${esc(domain.name)}</td>
        <td>${zoneLink}</td>
        <td>${domain.mailboxCount}</td>
        <td>${status}</td>
        <td class="actions">
          <button class="btn btn-primary btn-sm manage-domain-btn" type="button" ${domain.hetznerZoneId ? "" : "disabled"} title="${domain.hetznerZoneId ? "Open in Email view" : "Create a Hetzner zone with the same name first"}">Manage</button>
          <button class="btn btn-ghost btn-sm domain-health-btn" type="button">Health</button>
          <button class="btn btn-ghost btn-sm domain-webmail-btn" type="button">Webmail</button>
        </td>
      </tr>`;
    }).join("");
  }

  renderMailManagerStats();
  renderUnmanagedZones();
}

function renderMailboxes() {
  const body = $("#mailboxesBody");
  const zone = selectedZone();
  if (!zone || !state.poste.configured) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Select a zone to view mailboxes</td></tr>';
    return;
  }

  if (!state.poste.mailboxes.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">No mailboxes for this domain yet</td></tr>';
    return;
  }

  body.innerHTML = state.poste.mailboxes.map((mailbox) => {
    const role = mailbox.fullAdmin ? "Full admin" : mailbox.domainAdmin ? "Domain admin" : "User";
    const status = mailbox.disabled
      ? '<span class="badge badge-warn">Disabled</span>'
      : '<span class="badge badge-ok">Active</span>';
    return `<tr data-address="${escAttr(mailbox.address)}">
      <td class="name-cell">${esc(mailbox.address)}</td>
      <td>${esc(mailbox.name || "—")}</td>
      <td>${role}</td>
      <td>${status}</td>
      <td class="actions">
        <button class="btn btn-ghost btn-sm reset-mailbox-btn" type="button">Reset password</button>
        <button class="btn btn-danger btn-sm delete-mailbox-btn" type="button">Delete</button>
      </td>
    </tr>`;
  }).join("");
}

async function loadPosteStatus() {
  const zone = selectedZone();
  const query = zone ? `?domain=${encodeURIComponent(zone.name)}` : "";
  const data = await api(`/api/poste/status${query}`);
  state.poste.configured = data.configured;
  state.poste.mailHost = data.mailHost || null;
  state.poste.webmailUrl = data.webmailUrl || null;
  state.poste.adminUrl = data.adminUrl || null;
  $("#posteNotConfigured").hidden = data.configured;
  $("#posteConfigured").hidden = !data.configured;
  $("#mailmanNotConfigured").hidden = data.configured;
  $("#mailmanConfigured").hidden = !data.configured;
  if (data.configured && data.baseUrl) {
    $("#posteConnectionMeta").textContent = `${data.baseUrl} · ${data.adminEmail}`;
  }
  renderEmailView();
}

async function loadPosteOverview() {
  if (!state.poste.configured) {
    state.poste.overview = [];
    state.poste.unmanagedZones = [];
    state.poste.totals = null;
    renderPosteOverview();
    return;
  }
  const data = await api("/api/poste/overview");
  state.poste.overview = data.domains || [];
  state.poste.unmanagedZones = data.unmanagedZones || [];
  state.poste.totals = data.totals || null;
  state.poste.webmailUrl = data.webmailUrl || state.poste.webmailUrl;
  state.poste.adminUrl = data.adminUrl || state.poste.adminUrl;
  renderPosteOverview();
  setActionButtons();
}

function renderHealthModal(data) {
  const body = $("#healthModalBody");
  const lines = [];

  lines.push(`<div class="health-summary">
    <div><strong>Domain</strong> ${esc(data.domain)}</div>
    <div><strong>Mail host</strong> ${esc(data.mailHost || "—")}</div>
    <div><strong>Poste.io</strong> ${data.registered ? '<span class="badge badge-ok">Registered</span>' : '<span class="badge badge-warn">Not registered</span>'}</div>
    <div><strong>Mailboxes</strong> ${data.mailboxCount}</div>
    <div><strong>DKIM</strong> ${data.dkim?.configured ? `<span class="badge badge-ok">Configured (${esc(data.dkim.selector)})</span>` : '<span class="badge badge-warn">Not configured</span>'}</div>
  </div>`);

  if (data.quota) {
    const used = data.quota.used ?? data.quota.usedBytes;
    const limit = data.quota.limit ?? data.quota.quota;
    if (used != null && limit != null) {
      lines.push(`<div class="hint small">Storage: ${esc(String(used))} / ${esc(String(limit))}</div>`);
    }
  }

  if (data.gaps) {
    lines.push('<div class="health-dns"><h4>DNS records</h4>');
    if (data.dnsComplete) {
      lines.push('<div class="hint small">All recommended mail DNS records are configured in Hetzner.</div>');
    }
    for (const key of ["mx", "spf", "dkim", "dmarc", "autoconfig", "autodiscover"]) {
      const gap = data.gaps[key];
      if (!gap) continue;
      const existing = gap.existing?.length
        ? `<div class="hint small">Current: ${esc(gap.existing.join(" | "))}</div>`
        : "";
      lines.push(`<div class="line-ok">${gapStatusBadge(gap.status)} <strong>${esc(gap.label)}</strong> ${esc(gap.host)}${existing}</div>`);
    }
    lines.push("</div>");
  } else {
    lines.push('<div class="hint small">Link a Hetzner zone to compare DNS records.</div>');
  }

  if (data.mailboxes?.length) {
    lines.push(`<div class="health-mailboxes"><h4>Mailboxes (${data.mailboxCount})</h4><ul class="health-list">${data.mailboxes.map((m) => `<li>${esc(m.address)}${m.disabled ? " (disabled)" : ""}</li>`).join("")}</ul></div>`);
  }

  body.innerHTML = lines.join("");
  const webmailBtn = $("#healthWebmailBtn");
  webmailBtn.hidden = !data.webmailUrl;
  webmailBtn.dataset.url = data.webmailUrl || "";
}

async function openHealthModal(domainName) {
  const zone = selectedZone();
  const domain = domainName || zone?.name;
  if (!domain) {
    showToast("Select a zone first", "error");
    return;
  }

  const modal = $("#healthModal");
  $("#healthModalTitle").textContent = `Mail health — ${domain}`;
  $("#healthModalBody").innerHTML = '<p class="empty">Loading health data…</p>';
  $("#healthWebmailBtn").hidden = true;
  modal.showModal();

  const zoneId = zone?.name === domain ? zone.id : state.poste.overview.find((d) => d.name === domain)?.hetznerZoneId;
  const params = new URLSearchParams();
  if (zoneId) params.set("zoneId", zoneId);
  params.set("dmarcEmail", domain === zone?.name ? posteDmarcEmail() : `postmaster@${domain}`);

  try {
    const data = await api(`/api/poste/domains/${encodeURIComponent(domain)}/health?${params}`);
    renderHealthModal(data);
  } catch (err) {
    $("#healthModalBody").innerHTML = `<p class="empty">${esc(err.message)}</p>`;
  }
}

function openPosteUrl(url) {
  if (!url) {
    showToast("Poste.io URL not configured", "error");
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

async function loadPosteForZone() {
  const zone = selectedZone();
  if (!zone || !state.poste.configured) {
    state.poste.registered = false;
    state.poste.dns = null;
    state.poste.gaps = null;
    state.poste.toApply = [];
    state.poste.mailboxes = [];
    state.poste.dnsComplete = false;
    renderPosteDnsPreview();
    renderPosteBadge();
    renderMailboxes();
    setActionButtons();
    return;
  }

  const dmarcEmail = posteDmarcEmail();
  const [domainRes, dnsRes, mailboxRes] = await Promise.all([
    api(`/api/poste/domains/${encodeURIComponent(zone.name)}`),
    api(`/api/poste/domains/${encodeURIComponent(zone.name)}/dns?zoneId=${encodeURIComponent(zone.id)}&dmarcEmail=${encodeURIComponent(dmarcEmail)}`),
    api(`/api/poste/mailboxes?domain=${encodeURIComponent(zone.name)}`),
  ]);

  state.poste.registered = domainRes.registered;
  state.poste.dns = dnsRes.dns;
  state.poste.gaps = dnsRes.gaps;
  state.poste.toApply = dnsRes.toApply || [];
  state.poste.mailHost = dnsRes.mailHost || null;
  state.poste.mailboxes = mailboxRes.mailboxes;
  state.poste.dnsComplete = computeDnsComplete(state.poste.gaps);
  renderPosteDnsPreview();
  renderPosteBadge();
  renderMailboxes();
  setActionButtons();
}

async function runPosteSetup({ register = false }) {
  const zone = selectedZone();
  if (!zone) return;

  const data = await api(`/api/zones/${zone.id}/poste-setup`, {
    method: "POST",
    body: JSON.stringify({
      domain: zone.name,
      dmarcEmail: posteDmarcEmail(),
      register,
    }),
  });

  const dnsFailed = data.dnsResults.filter((r) => r.status === "error");
  const appliedCount = (data.toApply || []).length;
  if (dnsFailed.length) {
    showToast(`DNS failed: ${dnsFailed.map((f) => `${f.name} ${f.type}`).join(", ")}`, "error");
  } else if (!appliedCount) {
    showToast(`All mail DNS records already configured for ${zone.name}`);
  } else if (data.dnsResults.every((r) => r.unchanged)) {
    showToast(`Poste.io DNS already up to date for ${zone.name}`);
  } else {
    showToast(`Applied ${data.dnsResults.length} DNS record(s) for ${zone.name}`);
  }

  if (register) {
    if (data.registration?.status === "error") {
      showToast(`Registration failed: ${data.registration.error}`, "error");
    } else {
      showToast(`Domain registered on Poste.io: ${zone.name}`);
    }
  }

  await loadRecords();
  await loadPosteOverview();
  await loadPosteForZone();
}

async function createMailbox(e) {
  e.preventDefault();
  const zone = selectedZone();
  if (!zone) return;

  const local = $("#mailboxLocal").value.trim();
  if (!local) { showToast("Enter a mailbox name", "error"); return; }

  const generate = $("#mailboxGenPass").checked;
  const password = generate ? undefined : $("#mailboxPassword").value;
  if (!generate && (!password || password.length < 8)) {
    showToast("Password must be at least 8 characters", "error");
    return;
  }

  try {
    const data = await api("/api/poste/mailboxes", {
      method: "POST",
      body: JSON.stringify({
        address: `${local}@${zone.name}`,
        name: $("#mailboxName").value.trim() || undefined,
        generate,
        password,
      }),
    });

    $("#mailboxModal").close();
    if (data.generatedPassword) {
      await Swal.fire({
        ...swalBase,
        icon: "success",
        title: "Mailbox created",
        html: `<p><strong>${esc(local)}@${esc(zone.name)}</strong></p><p class="mono-pass">${esc(data.generatedPassword)}</p><p class="hint">Save this password — it won't be shown again.</p>`,
      });
    } else {
      showToast(`Mailbox created: ${local}@${zone.name}`);
    }
    await loadPosteOverview();
    await loadPosteForZone();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function resetMailboxPassword(address) {
  const result = await Swal.fire({
    ...swalBase,
    icon: "question",
    title: "Reset password?",
    text: address,
    showCancelButton: true,
    confirmButtonText: "Generate new password",
  });
  if (!result.isConfirmed) return;

  try {
    const data = await api(`/api/poste/mailboxes/${encodeURIComponent(address)}/password`, {
      method: "PATCH",
      body: JSON.stringify({ generate: true }),
    });
    await Swal.fire({
      ...swalBase,
      icon: "success",
      title: "Password reset",
      html: `<p><strong>${esc(address)}</strong></p><p class="mono-pass">${esc(data.generatedPassword)}</p>`,
    });
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function deleteMailbox(address) {
  const ok = await confirmDelete("Delete mailbox?", `Permanently delete <strong>${esc(address)}</strong> and all mail data?`);
  if (!ok) return;
  try {
    await api(`/api/poste/mailboxes/${encodeURIComponent(address)}`, { method: "DELETE" });
    showToast(`Deleted ${address}`);
    await loadPosteOverview();
    await loadPosteForZone();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function loadZones() { state.zones = (await api("/api/zones")).zones; renderZoneSelect(); }
async function loadServers() { state.servers = (await api("/api/servers")).servers; renderServerSelects(); }
async function loadRecords() {
  if (!state.selectedZoneId) { state.rrsets = []; renderRecords(); return; }
  state.rrsets = (await api(`/api/zones/${state.selectedZoneId}/rrsets`)).rrsets;
  renderRecords();
}

async function refreshAll() {
  try {
    await Promise.all([loadZones(), loadServers(), loadPosteStatus()]);
    syncPosteDmarcEmail();
    await loadRecords();
    if (state.activeView === "mailman") await loadPosteOverview();
    await loadPosteForZone();
    updateMailPreview();
    setActionButtons();
    showToast("Refreshed");
  } catch (err) { showToast(err.message, "error"); }
}

function openRecordModal(record = null) {
  state.editingRecord = record;
  $("#recordModalTitle").textContent = record ? "Edit record" : "Add record";
  $("#recordName").value = record?.name || "";
  $("#recordType").value = record?.type || "A";
  $("#recordTtl").value = record?.ttl || 3600;
  $("#recordValues").value = record ? formatValues(record) : "";
  $("#recordType").disabled = !!record;
  $("#recordName").disabled = !!record;
  recordModal.showModal();
}

function closeRecordModal() { recordModal.close(); state.editingRecord = null; }

async function saveRecord(e) {
  e.preventDefault();
  const zoneId = state.selectedZoneId;
  if (!zoneId) return;
  const name = $("#recordName").value.trim();
  const type = $("#recordType").value;
  const ttl = parseInt($("#recordTtl").value, 10);
  const records = parseValues(type, $("#recordValues").value);
  try {
    if (state.editingRecord) {
      await api(`/api/zones/${zoneId}/rrsets/${encodeURIComponent(name)}/${type}`, { method: "PUT", body: JSON.stringify({ ttl, records }) });
      showToast(`Updated ${name} ${type}`);
    } else {
      await api(`/api/zones/${zoneId}/rrsets`, { method: "POST", body: JSON.stringify({ name, type, ttl, records }) });
      showToast(`Created ${name} ${type}`);
    }
    closeRecordModal();
    await loadRecords();
    await loadZones();
    renderZoneMeta(selectedZone());
  } catch (err) { showToast(err.message, "error"); }
}

async function deleteRecord(name, type) {
  if (isProtectedRecord(type)) {
    showToast(`${type} records cannot be deleted`, "error");
    return;
  }
  const zone = selectedZone();
  const label = displayName(name, zone?.name || "");
  if (!(await confirmDelete(
    "Delete record?",
    `Remove <strong>${esc(type)}</strong> for <code>${esc(label)}</code>?`
  ))) return;
  try {
    await api(`/api/zones/${state.selectedZoneId}/rrsets/${encodeURIComponent(name)}/${type}`, { method: "DELETE" });
    showToast(`Deleted ${label} ${type}`);
    await loadRecords();
    await loadZones();
    renderZoneMeta(selectedZone());
  } catch (err) { showToast(err.message, "error"); }
}

async function createZone(e) {
  e.preventDefault();
  const name = $("#newZoneName").value.trim().toLowerCase();
  const ttl = parseInt($("#newZoneTtl").value, 10) || 3600;
  try {
    const data = await api("/api/zones", { method: "POST", body: JSON.stringify({ name, ttl }) });
    zoneModal.close();
    $("#newZoneName").value = "";
    state.selectedZoneId = data.zone.id;
    await loadZones();
    zoneSelect.value = String(data.zone.id);
    renderZoneMeta(data.zone);
    await loadRecords();
    setActionButtons();
    updateMailPreview();
    showToast(`Created zone ${name}`);
  } catch (err) { showToast(err.message, "error"); }
}

async function deleteZone() {
  const zone = selectedZone();
  if (!zone) return;
  if (zone.protection?.delete) {
    showToast("Zone delete protection is enabled", "error");
    return;
  }
  if (!(await confirmZoneDelete(zone.name))) return;
  try {
    await api(`/api/zones/${zone.id}`, { method: "DELETE" });
    showToast(`Deleted zone ${zone.name}`);
    state.selectedZoneId = null;
    zoneSelect.value = "";
    zoneMeta.hidden = true;
    await loadZones();
    await loadRecords();
    setActionButtons();
    updateMailPreview();
  } catch (err) { showToast(err.message, "error"); }
}

async function applyMailSetup(e) {
  e.preventDefault();
  const zone = selectedZone();
  if (!zone) return;
  const ipv4 = $("#mailIpv4Manual").value.trim() || $("#mailIpv4").value;
  if (!ipv4) { showToast("Select or enter IPv4", "error"); return; }
  try {
    const data = await api(`/api/zones/${zone.id}/mail-setup`, {
      method: "POST",
      body: JSON.stringify({
        domain: zone.name,
        mailHost: $("#mailHost").value.trim() || "mail",
        ipv4,
        mxPriority: parseInt($("#mxPriority").value, 10) || 10,
        dmarcEmail: $("#dmarcEmail").value.trim() || undefined,
        spf: $("#spfRecord").value.trim() || undefined,
      }),
    });
    const failed = data.results.filter((r) => r.status === "error");
    if (failed.length) {
      showToast(`Failed: ${failed.map((f) => `${f.name} ${f.type}`).join(", ")}`, "error");
    } else if (data.results.every((r) => r.unchanged)) {
      showToast(`Mail records already up to date for ${zone.name}`);
    } else {
      showToast(`Mail records applied for ${zone.name}`);
    }
    $("#newPtr").value = data.mailFqdn;
    await loadRecords();
    await loadZones();
    renderZoneMeta(selectedZone());
  } catch (err) { showToast(err.message, "error"); }
}

async function applyRdns(e) {
  e.preventDefault();
  const serverId = $("#rdnsServer").value;
  const opt = $("#rdnsServer").selectedOptions[0];
  const ip = opt?.dataset.ip;
  const dns_ptr = $("#newPtr").value.trim();
  if (!serverId || !ip || !dns_ptr) { showToast("Select server and PTR hostname", "error"); return; }
  try {
    await api(`/api/servers/${serverId}/rdns`, { method: "POST", body: JSON.stringify({ ip, dns_ptr }) });
    showToast(`rDNS set to ${dns_ptr}`);
    await loadServers();
    $("#currentPtr").value = dns_ptr;
  } catch (err) { showToast(err.message, "error"); }
}

function esc(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function escAttr(str) { return String(str).replace(/"/g,"&quot;"); }
function truncateDns(value, max = 120) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Copied to clipboard");
  } catch {
    showToast("Could not copy", "error");
  }
}

$("#refreshBtn").addEventListener("click", refreshAll);
$("#logoutBtn").addEventListener("click", async () => {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    window.location.href = "/login";
  } catch {
    window.location.href = "/login";
  }
});
$("#goMailmanBtn")?.addEventListener("click", () => switchView("mailman"));
$("#mailmanSearch")?.addEventListener("input", () => renderPosteOverview());
$("#posteDnsPreview")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".copy-dns-btn");
  if (!btn?.dataset.copy) return;
  copyText(btn.dataset.copy);
});
$("#unmanagedZonesBody")?.addEventListener("click", async (e) => {
  const row = e.target.closest("tr");
  if (!row?.dataset.zoneId || !e.target.classList.contains("setup-email-btn")) return;
  try {
    await openEmailForZone(row.dataset.zoneId, row.dataset.domain);
  } catch (err) {
    showToast(err.message, "error");
  }
});
zoneSelect.addEventListener("change", async () => {
  state.selectedZoneId = zoneSelect.value || null;
  renderZoneMeta(selectedZone());
  syncCheckHostname();
  syncPosteDmarcEmail();
  try {
    await loadRecords();
    updateMailPreview();
    await loadPosteForZone();
    setActionButtons();
  } catch (err) { showToast(err.message, "error"); }
});
$("#posteDmarcEmail").addEventListener("input", (e) => {
  e.target.dataset.autofill = "false";
  loadPosteForZone().catch((err) => showToast(err.message, "error"));
});
$("#posteWebmailBtn").addEventListener("click", () => openPosteUrl(state.poste.webmailUrl));
$("#posteAdminBtn").addEventListener("click", () => openPosteUrl(state.poste.adminUrl));
$("#posteHealthBtn").addEventListener("click", () => {
  openHealthModal().catch((err) => showToast(err.message, "error"));
});
$("#posteOverviewRefreshBtn").addEventListener("click", () => {
  loadPosteOverview().catch((err) => showToast(err.message, "error"));
});
$("#posteDomainsBody").addEventListener("click", async (e) => {
  const row = e.target.closest("tr");
  if (!row?.dataset.domain) return;
  const domain = row.dataset.domain;
  if (e.target.classList.contains("manage-domain-btn") && row.dataset.zoneId) {
    try {
      await openEmailForZone(row.dataset.zoneId, domain);
    } catch (err) {
      showToast(err.message, "error");
    }
    return;
  }
  if (e.target.classList.contains("domain-health-btn")) {
    openHealthModal(domain).catch((err) => showToast(err.message, "error"));
    return;
  }
  if (e.target.classList.contains("domain-webmail-btn")) {
    openPosteUrl(state.poste.webmailUrl);
  }
});
$("#closeHealthModalBtn").addEventListener("click", () => $("#healthModal").close());
$("#cancelHealthModalBtn").addEventListener("click", () => $("#healthModal").close());
$("#healthWebmailBtn").addEventListener("click", () => {
  openPosteUrl($("#healthWebmailBtn").dataset.url || state.poste.webmailUrl);
});
$("#posteRefreshBtn").addEventListener("click", () => {
  loadPosteForZone().catch((err) => showToast(err.message, "error"));
});
$("#posteApplyDnsBtn").addEventListener("click", () => {
  runPosteSetup({ register: false }).catch((err) => showToast(err.message, "error"));
});
$("#posteRegisterBtn").addEventListener("click", async () => {
  const zone = selectedZone();
  if (!zone) return;
  try {
    await api(`/api/poste/domains/${encodeURIComponent(zone.name)}/register`, { method: "POST" });
    showToast(`Domain registered on Poste.io: ${zone.name}`);
    await loadPosteForZone();
    await loadPosteOverview();
  } catch (err) {
    showToast(err.message, "error");
  }
});
$("#posteFullSetupBtn").addEventListener("click", () => {
  runPosteSetup({ register: true }).catch((err) => showToast(err.message, "error"));
});
$("#createMailboxBtn").addEventListener("click", () => {
  const zone = selectedZone();
  if (!zone) return;
  $("#mailboxLocal").value = "";
  $("#mailboxName").value = "";
  $("#mailboxGenPass").checked = true;
  $("#mailboxPassword").value = "";
  syncMailboxPasswordField();
  $("#mailboxModal").showModal();
});
$("#mailboxGenPass").addEventListener("change", syncMailboxPasswordField);
$("#mailboxForm").addEventListener("submit", createMailbox);
$("#closeMailboxModalBtn").addEventListener("click", () => $("#mailboxModal").close());
$("#cancelMailboxModalBtn").addEventListener("click", () => $("#mailboxModal").close());
$("#mailboxesBody").addEventListener("click", (e) => {
  const row = e.target.closest("tr");
  if (!row?.dataset.address) return;
  if (e.target.classList.contains("reset-mailbox-btn")) {
    resetMailboxPassword(row.dataset.address);
  }
  if (e.target.classList.contains("delete-mailbox-btn")) {
    deleteMailbox(row.dataset.address);
  }
});
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});
$("#checkHostname")?.addEventListener("input", (e) => {
  e.target.dataset.autofill = "false";
});
$("#propagationForm")?.addEventListener("submit", runPropagationCheck);
$("#addRecordBtn").addEventListener("click", () => openRecordModal());
$("#recordForm").addEventListener("submit", saveRecord);
$("#closeModalBtn").addEventListener("click", closeRecordModal);
$("#cancelModalBtn").addEventListener("click", closeRecordModal);
recordsBody.addEventListener("click", (e) => {
  const row = e.target.closest("tr");
  if (!row?.dataset.name) return;
  const { name, type } = row.dataset;
  const record = state.rrsets.find((r) => r.name === name && r.type === type);
  if (e.target.classList.contains("edit-btn") && record) {
    if (isProtectedRecord(type)) {
      showToast(`${type} records cannot be edited`, "error");
      return;
    }
    openRecordModal(record);
  }
  if (e.target.classList.contains("check-btn")) {
    openPropagationForRecord(name, type);
    return;
  }
  if (e.target.classList.contains("delete-btn")) deleteRecord(name, type);
});
$("#newZoneBtn").addEventListener("click", () => zoneModal.showModal());
$("#deleteZoneBtn").addEventListener("click", deleteZone);
$("#zoneForm").addEventListener("submit", createZone);
$("#closeZoneModalBtn").addEventListener("click", () => zoneModal.close());
$("#cancelZoneModalBtn").addEventListener("click", () => zoneModal.close());
$("#mailForm").addEventListener("submit", applyMailSetup);
["mailHost","mailIpv4","mailIpv4Manual","mxPriority","dmarcEmail","spfRecord"].forEach((id) =>
  $(`#${id}`).addEventListener("input", updateMailPreview));
$("#mailIpv4").addEventListener("change", updateMailPreview);
$("#rdnsForm").addEventListener("submit", applyRdns);
$("#rdnsServer").addEventListener("change", () => {
  const opt = $("#rdnsServer").selectedOptions[0];
  $("#currentPtr").value = opt?.dataset.ptr || "";
  if (!$("#newPtr").value && selectedZone()) {
    $("#newPtr").value = `${$("#mailHost").value.trim() || "mail"}.${selectedZone().name}`;
  }
  setActionButtons();
});
$("#recordType").addEventListener("change", () => {
  const type = $("#recordType").value;
  const hint = $("#valueHint");
  if (type === "MX") hint.textContent = "Format: 10 mail.example.com.";
  else if (type === "TXT") hint.textContent = "Quotes added automatically";
  else if (type === "CNAME" || type === "NS") hint.textContent = "Trailing dot added automatically";
  else hint.textContent = "One value per line";
});

refreshAll();
syncCheckHostname();
loadPosteStatus().catch(() => {});
