<script setup>
import { computed, reactive, ref } from "vue";
import { CheckCircle2, CircleAlert, Radar, Search } from "@lucide/vue";
import { api } from "../api.js";

const props = defineProps({
  selectedZone: Object,
  records: { type: Array, required: true },
});
const emit = defineEmits(["notify"]);

const form = reactive({
  hostname: "",
  compare: true,
  types: ["A"],
});
const loading = ref(false);
const result = ref(null);
const typeOptions = ["A", "AAAA", "MX", "TXT", "NS", "CNAME"];

const summaryItems = computed(() =>
  Object.entries(result.value?.summary || {}).map(([type, summary]) => ({
    type,
    ...summary,
  }))
);

function toggleType(type) {
  form.types = form.types.includes(type)
    ? form.types.filter((item) => item !== type)
    : [...form.types, type];
}

function expectedValues() {
  if (!form.compare || !props.selectedZone) return {};
  const expected = {};
  for (const type of form.types) {
    const matches = props.records.filter((record) => {
      if (record.type !== type) return false;
      const hostname =
        record.name === "@"
          ? props.selectedZone.name
          : `${record.name}.${props.selectedZone.name}`;
      return hostname.toLowerCase() === form.hostname.toLowerCase();
    });
    if (matches.length) {
      expected[type] = matches.flatMap((record) =>
        record.records.map((item) => item.value)
      );
    }
  }
  return expected;
}

async function runCheck() {
  if (!form.types.length) {
    emit("notify", "Select at least one record type", "error");
    return;
  }
  loading.value = true;
  try {
    result.value = await api("/api/dns-check", {
      method: "POST",
      body: JSON.stringify({
        hostname: form.hostname,
        types: form.types,
        expected: expectedValues(),
      }),
    });
  } catch (err) {
    emit("notify", err.message, "error");
  } finally {
    loading.value = false;
  }
}

function stateLabel(state) {
  return {
    propagated: "Propagated",
    partial: "Partial",
    mixed: "Mixed",
    not_found: "Not found",
    failed: "Failed",
  }[state] || state;
}
</script>

<template>
  <div class="propagation-stack">
    <section class="section-panel">
      <div class="section-heading">
        <div>
          <h2>Global propagation check</h2>
          <p>Query twelve public resolvers and compare the result with the active zone.</p>
        </div>
        <Radar :size="22" class="heading-icon" />
      </div>
      <form class="propagation-form" @submit.prevent="runCheck">
        <label class="field grow">
          <span>Hostname</span>
          <div class="input-with-icon">
            <Search :size="17" />
            <input
              v-model.trim="form.hostname"
              :placeholder="selectedZone?.name || 'example.com'"
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
        <label class="check-control">
          <input v-model="form.compare" type="checkbox" />
          Compare with selected zone
        </label>
        <button class="button primary" :disabled="loading">
          {{ loading ? "Checking..." : "Run check" }}
        </button>
      </form>
    </section>

    <section v-if="result" class="metric-strip propagation-summary">
      <div v-for="item in summaryItems" :key="item.type" class="metric-item">
        <CheckCircle2 v-if="item.state === 'propagated'" :size="20" class="ok" />
        <CircleAlert v-else :size="20" class="warn" />
        <div>
          <strong>{{ item.type }} · {{ stateLabel(item.state) }}</strong>
          <span>{{ item.ok }}/{{ item.total }} resolvers agree</span>
        </div>
      </div>
    </section>

    <section v-if="result" class="table-panel">
      <div class="table-tools">
        <strong>Resolver results</strong>
        <span>{{ new Date(result.checkedAt).toLocaleString() }}</span>
      </div>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Resolver</th><th>Region</th><th>Type</th><th>Status</th><th>Response</th><th>Latency</th><th>Zone</th></tr></thead>
          <tbody>
            <tr v-for="row in result.checks" :key="`${row.resolverId}:${row.type}`">
              <td><strong>{{ row.resolver }}</strong><small class="mono table-sub">{{ row.server }}</small></td>
              <td>{{ row.region }}</td>
              <td><span class="type-label">{{ row.type }}</span></td>
              <td><span class="row-status" :class="{ issue: row.status !== 'ok' }">{{ row.status }}</span></td>
              <td class="record-value">{{ row.values?.join(", ") || row.error }}</td>
              <td class="mono">{{ row.latencyMs }}ms</td>
              <td>{{ row.match === null ? "—" : row.match ? "Match" : "Mismatch" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
