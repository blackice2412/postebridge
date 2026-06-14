<script setup>
import { computed, reactive, ref, watch } from "vue";
import {
  CheckCircle2,
  Edit3,
  Globe2,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Trash2,
} from "@lucide/vue";
import BaseModal from "./BaseModal.vue";
import { api, withConnection } from "../api.js";

const props = defineProps({
  provider: { type: String, required: true },
  connectionId: { type: String, required: true },
  zones: { type: Array, required: true },
  selectedZoneId: [String, Number],
  records: { type: Array, required: true },
  loading: Boolean,
});
const emit = defineEmits([
  "select-zone",
  "refresh",
  "reload",
  "notify",
]);

const query = ref("");
const recordModal = ref(false);
const zoneModal = ref(false);
const editing = ref(null);
const saving = ref(false);
const recordForm = reactive({
  name: "",
  type: "A",
  ttl: 3600,
  values: "",
});
const zoneForm = reactive({ name: "", ttl: 3600 });

const selectedZone = computed(() =>
  props.zones.find((zone) => String(zone.id) === String(props.selectedZoneId))
);
const filteredRecords = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return props.records;
  return props.records.filter((record) =>
    [record.name, record.type, ...record.records.map((item) => item.value)]
      .join(" ")
      .toLowerCase()
      .includes(needle)
  );
});
const protectedTypes = new Set(["NS", "SOA"]);

watch(
  () => props.provider,
  () => {
    query.value = "";
  }
);

function openRecord(record = null) {
  editing.value = record;
  recordForm.name = record?.name || "";
  recordForm.type = record?.type || "A";
  recordForm.ttl = record?.ttl || 3600;
  recordForm.values = record?.records.map((item) => item.value).join("\n") || "";
  recordModal.value = true;
}

function normalizedRecords() {
  return recordForm.values
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => ({ value }));
}

async function saveRecord() {
  saving.value = true;
  try {
    const body = JSON.stringify({
      name: recordForm.name,
      type: recordForm.type,
      ttl: Number(recordForm.ttl),
      records: normalizedRecords(),
      connectionId: props.connectionId,
    });
    const zoneId = encodeURIComponent(props.selectedZoneId);
    if (editing.value) {
      await api(
        withConnection(
          `/api/zones/${zoneId}/rrsets/${encodeURIComponent(recordForm.name)}/${recordForm.type}`,
          props.connectionId
        ),
        { method: "PUT", body }
      );
    } else {
      await api(withConnection(`/api/zones/${zoneId}/rrsets`, props.connectionId), {
        method: "POST",
        body,
      });
    }
    recordModal.value = false;
    emit("notify", editing.value ? "Record updated" : "Record created");
    emit("reload");
  } catch (err) {
    emit("notify", err.message, "error");
  } finally {
    saving.value = false;
  }
}

async function deleteRecord(record) {
  if (!window.confirm(`Delete ${record.type} record ${record.name}?`)) return;
  try {
    await api(
      withConnection(
        `/api/zones/${encodeURIComponent(props.selectedZoneId)}/rrsets/${encodeURIComponent(record.name)}/${record.type}`,
        props.connectionId
      ),
      { method: "DELETE" }
    );
    emit("notify", "Record deleted");
    emit("reload");
  } catch (err) {
    emit("notify", err.message, "error");
  }
}

async function createZone() {
  saving.value = true;
  try {
    const data = await api(withConnection("/api/zones", props.connectionId), {
      method: "POST",
      body: JSON.stringify({
        ...zoneForm,
        ttl: Number(zoneForm.ttl),
        connectionId: props.connectionId,
      }),
    });
    zoneModal.value = false;
    zoneForm.name = "";
    emit("notify", `Zone ${data.zone?.name || "created"}`);
    emit("refresh", data.zone?.id);
  } catch (err) {
    emit("notify", err.message, "error");
  } finally {
    saving.value = false;
  }
}

async function deleteZone() {
  if (!selectedZone.value) return;
  if (!window.confirm(`Delete ${selectedZone.value.name} and all its records?`)) return;
  try {
    await api(
      withConnection(
        `/api/zones/${encodeURIComponent(selectedZone.value.id)}`,
        props.connectionId
      ),
      { method: "DELETE" }
    );
    emit("notify", "Zone deleted");
    emit("refresh");
  } catch (err) {
    emit("notify", err.message, "error");
  }
}
</script>

<template>
  <div class="dns-stack">
    <section class="dns-toolbar">
      <label class="zone-picker">
        <span>Active zone</span>
        <select
          :value="selectedZoneId || ''"
          @change="$emit('select-zone', $event.target.value)"
        >
          <option value="">Select a zone</option>
          <option v-for="zone in zones" :key="zone.id" :value="zone.id">
            {{ zone.name }}
          </option>
        </select>
      </label>
      <div class="toolbar-actions">
        <button
          v-if="provider === 'hetzner'"
          class="button secondary"
          type="button"
          @click="zoneModal = true"
        >
          <Plus :size="17" /> New zone
        </button>
        <button
          class="button primary"
          type="button"
          :disabled="!selectedZone"
          @click="openRecord()"
        >
          <Plus :size="17" /> Add record
        </button>
        <button class="icon-button large" type="button" title="Refresh" @click="$emit('refresh')">
          <RefreshCw :size="18" :class="{ spinning: loading }" />
        </button>
      </div>
    </section>

    <section v-if="selectedZone" class="zone-summary">
      <div class="zone-identity">
        <span class="zone-globe"><Globe2 :size="21" /></span>
        <div><span>Zone</span><strong>{{ selectedZone.name }}</strong></div>
      </div>
      <div><span>Provider</span><strong class="capitalize">{{ provider }} DNS</strong></div>
      <div><span>Records</span><strong>{{ records.length }}</strong></div>
      <div><span>Status</span><strong class="status-good"><CheckCircle2 :size="16" /> Active</strong></div>
      <button
        v-if="provider === 'hetzner'"
        class="text-button danger-text"
        type="button"
        @click="deleteZone"
      >
        <Trash2 :size="15" /> Delete zone
      </button>
    </section>

    <section class="table-panel">
      <div class="table-tools">
        <label class="search-field">
          <Search :size="16" />
          <input v-model="query" placeholder="Filter records" />
        </label>
        <span>{{ filteredRecords.length }} records</span>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr><th>Name</th><th>Type</th><th>TTL</th><th>Value</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-if="!selectedZone">
              <td colspan="6" class="empty-state">Select a zone to view records.</td>
            </tr>
            <tr v-else-if="loading">
              <td colspan="6" class="empty-state">Loading records...</td>
            </tr>
            <tr v-else-if="!filteredRecords.length">
              <td colspan="6" class="empty-state">No matching records.</td>
            </tr>
            <tr v-for="record in filteredRecords" :key="`${record.name}:${record.type}`">
              <td class="record-name">{{ record.name }}</td>
              <td><span class="type-label">{{ record.type }}</span></td>
              <td class="mono">{{ record.ttl }}</td>
              <td class="record-value">
                <div v-for="item in record.records" :key="item.value" :title="item.value">
                  {{ item.value }}
                </div>
              </td>
              <td>
                <span class="row-status">
                  <Shield v-if="protectedTypes.has(record.type)" :size="15" />
                  <CheckCircle2 v-else :size="15" />
                  {{ protectedTypes.has(record.type) ? "System" : "OK" }}
                </span>
              </td>
              <td class="row-actions">
                <button
                  class="icon-button"
                  type="button"
                  title="Edit"
                  :disabled="protectedTypes.has(record.type)"
                  @click="openRecord(record)"
                >
                  <Edit3 :size="16" />
                </button>
                <button
                  class="icon-button danger"
                  type="button"
                  title="Delete"
                  :disabled="protectedTypes.has(record.type)"
                  @click="deleteRecord(record)"
                >
                  <Trash2 :size="16" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <BaseModal
      v-if="recordModal"
      :title="editing ? 'Edit DNS record' : 'Add DNS record'"
      @close="recordModal = false"
    >
      <form class="modal-form" @submit.prevent="saveRecord">
        <div class="form-grid two">
          <label class="field"><span>Name</span><input v-model.trim="recordForm.name" placeholder="@ or subdomain" required :disabled="!!editing" /></label>
          <label class="field">
            <span>Type</span>
            <select v-model="recordForm.type" :disabled="!!editing">
              <option v-for="type in ['A','AAAA','CNAME','MX','TXT','SRV','CAA','ALIAS']" :key="type">{{ type }}</option>
            </select>
          </label>
        </div>
        <label class="field"><span>TTL</span><input v-model.number="recordForm.ttl" type="number" min="60" required /></label>
        <label class="field"><span>Values, one per line</span><textarea v-model="recordForm.values" rows="5" required /></label>
        <div class="modal-actions">
          <button class="button ghost" type="button" @click="recordModal = false">Cancel</button>
          <button class="button primary" :disabled="saving">{{ saving ? "Saving..." : "Save record" }}</button>
        </div>
      </form>
    </BaseModal>

    <BaseModal v-if="zoneModal" title="Create Hetzner zone" @close="zoneModal = false">
      <form class="modal-form" @submit.prevent="createZone">
        <label class="field"><span>Domain</span><input v-model.trim="zoneForm.name" placeholder="example.com" required /></label>
        <label class="field"><span>Default TTL</span><input v-model.number="zoneForm.ttl" type="number" min="60" /></label>
        <div class="modal-actions">
          <button class="button ghost" type="button" @click="zoneModal = false">Cancel</button>
          <button class="button primary" :disabled="saving">Create zone</button>
        </div>
      </form>
    </BaseModal>
  </div>
</template>
