<script setup>
import { computed, reactive, ref, watch } from "vue";
import {
  CheckCircle2,
  CircleAlert,
  Globe2,
  LoaderCircle,
  Radar,
  Search,
} from "@lucide/vue";
import { api, streamDnsCheck, withConnection } from "../api.js";

const RESOLVER_COUNT = 12;
const typeOptions = ["A", "AAAA", "MX", "TXT", "NS", "CNAME"];
const RESOLVERS = [
  { id: "google-primary", name: "Google Public DNS", region: "United States", server: "8.8.8.8" },
  { id: "google-secondary", name: "Google Public DNS", region: "United States", server: "8.8.4.4" },
  { id: "cloudflare-primary", name: "Cloudflare", region: "Global", server: "1.1.1.1" },
  { id: "cloudflare-secondary", name: "Cloudflare", region: "Global", server: "1.0.0.1" },
  { id: "quad9", name: "Quad9", region: "Global", server: "9.9.9.9" },
  { id: "opendns-primary", name: "OpenDNS", region: "United States", server: "208.67.222.222" },
  { id: "opendns-secondary", name: "OpenDNS", region: "United States", server: "208.67.220.220" },
  { id: "comodo", name: "Comodo Secure DNS", region: "United States", server: "8.26.56.26" },
  { id: "yandex", name: "Yandex DNS", region: "Russia", server: "77.88.8.8" },
  { id: "cleanbrowsing", name: "CleanBrowsing", region: "United States", server: "185.228.168.9" },
  { id: "level3", name: "Level3", region: "United States", server: "4.2.2.1" },
  { id: "verisign", name: "Verisign", region: "United States", server: "64.6.64.6" },
];

const props = defineProps({
  zones: { type: Array, required: true },
  connectionId: { type: String, default: "" },
  selectedZone: Object,
  records: { type: Array, required: true },
});
const emit = defineEmits(["notify"]);

const form = reactive({
  mode: "zone",
  zoneId: "",
  hostname: "",
  compare: true,
  types: ["A"],
});
const loading = ref(false);
const checkedAt = ref(null);
const rows = ref([]);
const summary = ref({});
const zoneRecords = ref([]);
const loadingZoneRecords = ref(false);

const activeZone = computed(() =>
  props.zones.find((zone) => String(zone.id) === String(form.zoneId))
);
const compareRecords = computed(() =>
  form.mode === "zone" ? zoneRecords.value : props.records
);
const hostnameOptions = computed(() => {
  const zone = activeZone.value;
  if (!zone) return [];
  const names = new Set([zone.name.toLowerCase()]);
  for (const record of zoneRecords.value) {
    const fqdn =
      record.name === "@"
        ? zone.name
        : `${record.name}.${zone.name}`;
    names.add(fqdn.toLowerCase());
  }
  return [...names].sort();
});
const totalChecks = computed(() => form.types.length * RESOLVER_COUNT);
const completedChecks = computed(
  () => rows.value.filter((row) => row.status !== "checking").length
);
const progressPercent = computed(() =>
  totalChecks.value
    ? Math.round((completedChecks.value / totalChecks.value) * 100)
    : 0
);
const summaryItems = computed(() =>
  Object.entries(summary.value).map(([type, item]) => ({ type, ...item }))
);
const hasResults = computed(() => rows.value.length > 0);

watch(
  () => props.selectedZone?.id,
  (zoneId) => {
    if (!form.zoneId && zoneId) form.zoneId = String(zoneId);
  },
  { immediate: true }
);

watch(
  () => form.zoneId,
  async (zoneId) => {
    if (form.mode !== "zone" || !zoneId) {
      zoneRecords.value = [];
      return;
    }
    await loadZoneRecords(zoneId);
    if (!form.hostname || !hostnameOptions.value.includes(form.hostname.toLowerCase())) {
      form.hostname = hostnameOptions.value[0] || activeZone.value?.name || "";
    }
  },
  { immediate: true }
);

watch(
  () => form.mode,
  (mode) => {
    if (mode === "zone") {
      form.zoneId = form.zoneId || String(props.selectedZone?.id || "");
      form.hostname = hostnameOptions.value[0] || activeZone.value?.name || "";
      form.compare = true;
      return;
    }
    form.hostname = form.hostname || props.selectedZone?.name || "";
  }
);

async function loadZoneRecords(zoneId) {
  if (!props.connectionId) {
    zoneRecords.value = props.records;
    return;
  }
  if (String(zoneId) === String(props.selectedZone?.id)) {
    zoneRecords.value = props.records;
    return;
  }
  loadingZoneRecords.value = true;
  try {
    const data = await api(
      withConnection(
        `/api/zones/${encodeURIComponent(zoneId)}/rrsets`,
        props.connectionId
      )
    );
    zoneRecords.value = data.rrsets || [];
  } catch (err) {
    zoneRecords.value = [];
    emit("notify", err.message, "error");
  } finally {
    loadingZoneRecords.value = false;
  }
}

function toggleType(type) {
  form.types = form.types.includes(type)
    ? form.types.filter((item) => item !== type)
    : [...form.types, type];
}

function recordHostname(record, zoneName) {
  return record.name === "@"
    ? zoneName
    : `${record.name}.${zoneName}`;
}

function expectedValues() {
  if (!form.compare) return {};
  const zone =
    form.mode === "zone" ? activeZone.value : props.selectedZone;
  if (!zone) return {};

  const expected = {};
  for (const type of form.types) {
    const matches = compareRecords.value.filter((record) => {
      if (record.type !== type) return false;
      return (
        recordHostname(record, zone.name).toLowerCase() ===
        form.hostname.trim().toLowerCase()
      );
    });
    if (matches.length) {
      expected[type] = matches.flatMap((record) =>
        record.records.map((item) => item.value)
      );
    }
  }
  return expected;
}

function buildPendingRows() {
  return form.types.flatMap((type) =>
    RESOLVERS.map((resolver) => ({
      key: `${resolver.id}:${type}`,
      resolver: resolver.name,
      resolverId: resolver.id,
      region: resolver.region,
      server: resolver.server,
      type,
      status: "checking",
      values: [],
      latencyMs: null,
      match: null,
      error: null,
    }))
  );
}

function summarizeLive(checks, type) {
  const typeChecks = checks.filter(
    (check) => check.type === type && check.status !== "checking"
  );
  const pending = RESOLVER_COUNT - typeChecks.length;
  if (pending > 0) {
    const ok = typeChecks.filter((check) => check.status === "ok").length;
    return {
      state: "checking",
      total: RESOLVER_COUNT,
      ok,
      errors: typeChecks.filter((check) => check.status !== "ok").length,
      pending,
      uniqueValues: 0,
    };
  }

  const okChecks = typeChecks.filter((check) => check.status === "ok");
  const errors = typeChecks.filter((check) => check.status !== "ok").length;
  const valueGroups = new Map();
  for (const check of okChecks) {
    const key = check.values.join("||");
    valueGroups.set(key, (valueGroups.get(key) || 0) + 1);
  }
  let state = "failed";
  if (okChecks.length === typeChecks.length && valueGroups.size === 1) {
    state = "propagated";
  } else if (okChecks.length > 0) {
    state = valueGroups.size > 1 ? "partial" : "mixed";
  } else if (errors > 0) {
    state = "not_found";
  }
  return {
    state,
    total: typeChecks.length,
    ok: okChecks.length,
    errors,
    uniqueValues: valueGroups.size,
    pending: 0,
  };
}

function updateSummary() {
  const next = {};
  for (const type of form.types) {
    next[type] = summarizeLive(rows.value, type);
  }
  summary.value = next;
}

function applyCheck(check) {
  const index = rows.value.findIndex(
    (row) => row.resolverId === check.resolverId && row.type === check.type
  );
  if (index === -1) return;
  rows.value[index] = {
    ...rows.value[index],
    ...check,
    key: `${check.resolverId}:${check.type}`,
  };
  updateSummary();
}

async function runCheck() {
  const hostname = form.hostname.trim();
  if (!hostname) {
    emit("notify", "Enter a hostname to check", "error");
    return;
  }
  if (!form.types.length) {
    emit("notify", "Select at least one record type", "error");
    return;
  }

  loading.value = true;
  checkedAt.value = new Date().toISOString();
  rows.value = buildPendingRows();
  summary.value = Object.fromEntries(
    form.types.map((type) => [
      type,
      {
        state: "checking",
        total: RESOLVER_COUNT,
        ok: 0,
        errors: 0,
        pending: RESOLVER_COUNT,
        uniqueValues: 0,
      },
    ])
  );

  try {
    await streamDnsCheck(
      {
        hostname,
        types: form.types,
        expected: expectedValues(),
      },
      {
        onCheck: applyCheck,
        onDone(payload) {
          checkedAt.value = payload.checkedAt;
          rows.value = payload.checks.map((check) => ({
            ...check,
            key: `${check.resolverId}:${check.type}`,
          }));
          summary.value = payload.summary;
        },
        onError(err) {
          emit("notify", err.message, "error");
        },
      }
    );
  } catch (err) {
    emit("notify", err.message, "error");
    rows.value = [];
    summary.value = {};
  } finally {
    loading.value = false;
  }
}

function stateLabel(state) {
  return {
    checking: "Checking",
    propagated: "Propagated",
    partial: "Partial",
    mixed: "Mixed",
    not_found: "Not found",
    failed: "Failed",
  }[state] || state;
}

function statusLabel(status) {
  return status === "checking" ? "Checking" : status.replaceAll("_", " ");
}
</script>

<template>
  <div class="propagation-stack">
    <section class="section-panel">
      <div class="section-heading">
        <div>
          <h2>Propagation check</h2>
          <p>
            Query twelve public resolvers in parallel and watch results stream in live.
          </p>
        </div>
        <Radar :size="22" class="heading-icon" />
      </div>

      <div class="propagation-mode">
        <button
          type="button"
          :class="{ active: form.mode === 'zone' }"
          @click="form.mode = 'zone'"
        >
          <Globe2 :size="15" />
          From zone
        </button>
        <button
          type="button"
          :class="{ active: form.mode === 'custom' }"
          @click="form.mode = 'custom'"
        >
          <Search :size="15" />
          Custom hostname
        </button>
      </div>

      <form class="propagation-form" @submit.prevent="runCheck">
        <template v-if="form.mode === 'zone'">
          <label class="field">
            <span>Zone</span>
            <select v-model="form.zoneId" :disabled="!zones.length || loadingZoneRecords">
              <option disabled value="">Select zone…</option>
              <option v-for="zone in zones" :key="zone.id" :value="String(zone.id)">
                {{ zone.name }}
              </option>
            </select>
          </label>
          <label class="field grow">
            <span>Hostname</span>
            <select v-model="form.hostname" :disabled="!hostnameOptions.length">
              <option disabled value="">Select hostname…</option>
              <option v-for="host in hostnameOptions" :key="host" :value="host">
                {{ host }}
              </option>
            </select>
          </label>
        </template>

        <label v-else class="field grow">
          <span>Hostname</span>
          <div class="input-with-icon">
            <Search :size="17" />
            <input
              v-model.trim="form.hostname"
              placeholder="example.com or mail.example.com"
              required
            />
          </div>
        </label>
        <div class="field">
          <span>Record types</span>
          <div class="type-choices">
            <button
              v-for="type in typeOptions"
              :key="type"
              type="button"
              :class="{ active: form.types.includes(type) }"
              @click="toggleType(type)"
            >
              {{ type }}
            </button>
          </div>
        </div>
        <label v-if="form.mode === 'zone'" class="check-control">
          <input v-model="form.compare" type="checkbox" />
          Compare with zone records
        </label>
        <button class="button primary" :disabled="loading || !form.hostname">
          {{ loading ? "Checking…" : "Run check" }}
        </button>
      </form>
    </section>

    <section v-if="hasResults" class="metric-strip propagation-summary">
      <div v-for="item in summaryItems" :key="item.type" class="metric-item">
        <LoaderCircle
          v-if="item.state === 'checking'"
          :size="20"
          class="spinning warn"
        />
        <CheckCircle2 v-else-if="item.state === 'propagated'" :size="20" class="ok" />
        <CircleAlert v-else :size="20" class="warn" />
        <div>
          <strong>{{ item.type }} · {{ stateLabel(item.state) }}</strong>
          <span v-if="item.state === 'checking'">
            {{ item.ok }}/{{ item.total }} complete
          </span>
          <span v-else>{{ item.ok }}/{{ item.total }} resolvers agree</span>
        </div>
      </div>
    </section>

    <section v-if="hasResults" class="table-panel">
      <div class="table-tools propagation-table-tools">
        <div class="propagation-progress">
          <strong>Resolver results</strong>
          <span v-if="loading">
            Checking {{ completedChecks }}/{{ totalChecks }} · {{ progressPercent }}%
          </span>
          <span v-else-if="checkedAt">
            Finished {{ new Date(checkedAt).toLocaleString() }}
          </span>
        </div>
        <div v-if="loading" class="progress-track" aria-hidden="true">
          <div class="progress-fill" :style="{ width: `${progressPercent}%` }" />
        </div>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Resolver</th>
              <th>Region</th>
              <th>Type</th>
              <th>Status</th>
              <th>Response</th>
              <th>Latency</th>
              <th>Zone</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rows"
              :key="row.key"
              :class="{ 'row-checking': row.status === 'checking' }"
            >
              <td>
                <strong>{{ row.resolver }}</strong>
                <small class="mono table-sub">{{ row.server }}</small>
              </td>
              <td>{{ row.region }}</td>
              <td><span class="type-label">{{ row.type }}</span></td>
              <td>
                <span
                  class="row-status"
                  :class="{
                    checking: row.status === 'checking',
                    issue: row.status !== 'ok' && row.status !== 'checking',
                  }"
                >
                  <LoaderCircle
                    v-if="row.status === 'checking'"
                    :size="13"
                    class="spinning"
                  />
                  {{ statusLabel(row.status) }}
                </span>
              </td>
              <td class="record-value">
                <span v-if="row.status === 'checking'" class="muted-copy">Waiting…</span>
                <span v-else>{{ row.values?.join(", ") || row.error }}</span>
              </td>
              <td class="mono">
                <span v-if="row.status === 'checking'">—</span>
                <span v-else>{{ row.latencyMs }}ms</span>
              </td>
              <td>
                <span v-if="row.status === 'checking'">—</span>
                <span v-else>
                  {{ row.match === null ? "—" : row.match ? "Match" : "Mismatch" }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
