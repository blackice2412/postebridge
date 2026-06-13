<script setup>
import { reactive, ref, watch } from "vue";
import { RotateCcw, Server } from "@lucide/vue";
import { api, withProvider } from "../api.js";

const props = defineProps({
  provider: { type: String, required: true },
  selectedZone: Object,
});
const emit = defineEmits(["notify"]);
const servers = ref([]);
const loading = ref(false);
const form = reactive({ serverId: "", ptr: "" });

watch(
  () => props.provider,
  () => loadServers(),
  { immediate: true }
);

async function loadServers() {
  servers.value = [];
  form.serverId = "";
  if (props.provider !== "hetzner") return;
  loading.value = true;
  try {
    servers.value = (
      await api(withProvider("/api/servers", props.provider))
    ).servers;
  } catch (err) {
    emit("notify", err.message, "error");
  } finally {
    loading.value = false;
  }
}

function selectedServer() {
  return servers.value.find((server) => String(server.id) === String(form.serverId));
}

function serverChanged() {
  const server = selectedServer();
  form.ptr = server?.dns_ptr || (props.selectedZone ? `mail.${props.selectedZone.name}` : "");
}

async function save() {
  const server = selectedServer();
  if (!server) return;
  loading.value = true;
  try {
    await api(
      withProvider(`/api/servers/${server.id}/rdns`, props.provider),
      {
        method: "POST",
        body: JSON.stringify({
          provider: props.provider,
          ip: server.ipv4,
          dns_ptr: form.ptr,
        }),
      }
    );
    emit("notify", "Reverse DNS updated");
    await loadServers();
  } catch (err) {
    emit("notify", err.message, "error");
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <section class="section-panel narrow-panel">
    <div class="section-heading">
      <div>
        <h2>Reverse DNS</h2>
        <p>Set a PTR record on a Hetzner server for outbound mail reputation.</p>
      </div>
      <RotateCcw :size="22" class="heading-icon" />
    </div>

    <div v-if="provider !== 'hetzner'" class="notice">
      <Server :size="20" />
      Reverse DNS management is available for Hetzner Cloud servers only.
    </div>
    <form v-else class="stack-form" @submit.prevent="save">
      <label class="field">
        <span>Server</span>
        <select v-model="form.serverId" required @change="serverChanged">
          <option value="">Select a server</option>
          <option v-for="server in servers" :key="server.id" :value="server.id">
            {{ server.name }} · {{ server.ipv4 }}
          </option>
        </select>
      </label>
      <label class="field">
        <span>PTR hostname</span>
        <input v-model.trim="form.ptr" placeholder="mail.example.com" required />
      </label>
      <button class="button primary" :disabled="loading || !form.serverId">
        {{ loading ? "Saving..." : "Update reverse DNS" }}
      </button>
    </form>
  </section>
</template>
