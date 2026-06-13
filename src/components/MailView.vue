<script setup>
import { computed, reactive, ref, watch } from "vue";
import {
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  KeyRound,
  Mail,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  WandSparkles,
} from "@lucide/vue";
import BaseModal from "./BaseModal.vue";
import { api, withProvider } from "../api.js";

const props = defineProps({
  provider: { type: String, required: true },
  selectedZone: Object,
  posteConfigured: Boolean,
});
const emit = defineEmits(["notify", "open-settings"]);

const loading = ref(false);
const status = ref(null);
const domainState = ref(null);
const dnsState = ref(null);
const mailboxes = ref([]);
const overview = ref(null);
const mailboxModal = ref(false);
const mailboxForm = reactive({
  local: "",
  name: "",
  generate: true,
  password: "",
});
const dmarcEmail = ref("");

const pendingCount = computed(() =>
  Object.values(dnsState.value?.gaps || {}).filter((gap) => gap.status !== "present").length
);
const dnsComplete = computed(
  () =>
    dnsState.value?.gaps &&
    Object.values(dnsState.value.gaps).every((gap) => gap.status === "present")
);

watch(
  [() => props.selectedZone?.id, () => props.provider, () => props.posteConfigured],
  () => load(),
  { immediate: true }
);

async function load() {
  status.value = null;
  domainState.value = null;
  dnsState.value = null;
  mailboxes.value = [];
  overview.value = null;
  if (!props.posteConfigured) return;

  loading.value = true;
  try {
    status.value = await api("/api/poste/status");
    overview.value = await api(withProvider("/api/poste/overview", props.provider));
    if (!props.selectedZone) return;

    const domain = encodeURIComponent(props.selectedZone.name);
    const providerQuery = `provider=${encodeURIComponent(props.provider)}`;
    const [domainData, dnsData, mailboxData] = await Promise.all([
      api(`/api/poste/domains/${domain}`),
      api(
        `/api/poste/domains/${domain}/dns?zoneId=${encodeURIComponent(props.selectedZone.id)}&dmarcEmail=${encodeURIComponent(dmarcEmail.value || `postmaster@${props.selectedZone.name}`)}&${providerQuery}`
      ),
      api(`/api/poste/mailboxes?domain=${domain}`),
    ]);
    domainState.value = domainData;
    dnsState.value = dnsData;
    mailboxes.value = mailboxData.mailboxes || [];
    if (!dmarcEmail.value) dmarcEmail.value = `postmaster@${props.selectedZone.name}`;
  } catch (err) {
    emit("notify", err.message, "error");
  } finally {
    loading.value = false;
  }
}

async function setup(register) {
  if (!props.selectedZone) return;
  loading.value = true;
  try {
    const data = await api(
      withProvider(
        `/api/zones/${encodeURIComponent(props.selectedZone.id)}/poste-setup`,
        props.provider
      ),
      {
        method: "POST",
        body: JSON.stringify({
          provider: props.provider,
          domain: props.selectedZone.name,
          dmarcEmail: dmarcEmail.value,
          register,
        }),
      }
    );
    const failures = data.dnsResults?.filter((item) => item.status === "error") || [];
    if (failures.length) {
      throw new Error(failures.map((item) => `${item.name}: ${item.error}`).join(", "));
    }
    emit("notify", register ? "Mail domain setup completed" : "Mail DNS records applied");
    await load();
  } catch (err) {
    emit("notify", err.message, "error");
  } finally {
    loading.value = false;
  }
}

async function registerDomain() {
  if (!props.selectedZone) return;
  loading.value = true;
  try {
    await api(`/api/poste/domains/${encodeURIComponent(props.selectedZone.name)}/register`, {
      method: "POST",
    });
    emit("notify", "Domain registered in Poste.io");
    await load();
  } catch (err) {
    emit("notify", err.message, "error");
  } finally {
    loading.value = false;
  }
}

async function createMailbox() {
  const address = `${mailboxForm.local}@${props.selectedZone.name}`;
  loading.value = true;
  try {
    const data = await api("/api/poste/mailboxes", {
      method: "POST",
      body: JSON.stringify({
        address,
        name: mailboxForm.name,
        generate: mailboxForm.generate,
        password: mailboxForm.generate ? undefined : mailboxForm.password,
      }),
    });
    mailboxModal.value = false;
    const suffix = data.generatedPassword
      ? ` Generated password: ${data.generatedPassword}`
      : "";
    emit("notify", `Mailbox ${address} created.${suffix}`);
    await load();
  } catch (err) {
    emit("notify", err.message, "error");
  } finally {
    loading.value = false;
  }
}

async function resetPassword(address) {
  if (!window.confirm(`Generate a new password for ${address}?`)) return;
  try {
    const data = await api(
      `/api/poste/mailboxes/${encodeURIComponent(address)}/password`,
      { method: "PATCH", body: JSON.stringify({ generate: true }) }
    );
    emit("notify", `New password for ${address}: ${data.generatedPassword}`);
  } catch (err) {
    emit("notify", err.message, "error");
  }
}

async function deleteMailbox(address) {
  if (!window.confirm(`Delete mailbox ${address}?`)) return;
  try {
    await api(`/api/poste/mailboxes/${encodeURIComponent(address)}`, {
      method: "DELETE",
    });
    emit("notify", "Mailbox deleted");
    await load();
  } catch (err) {
    emit("notify", err.message, "error");
  }
}

function openUrl(url) {
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}
</script>

<template>
  <div class="mail-stack">
    <section v-if="!posteConfigured" class="empty-setup">
      <div class="empty-icon"><Mail :size="26" /></div>
      <h2>Connect Poste.io</h2>
      <p>Add the Poste admin URL and credentials in Settings to manage domains and mailboxes.</p>
      <button class="button primary" @click="$emit('open-settings')">Open settings</button>
    </section>

    <template v-else>
      <section class="mail-header">
        <div>
          <span class="section-label">Active DNS zone</span>
          <h2>{{ selectedZone?.name || "Select a zone" }}</h2>
          <p v-if="selectedZone">
            {{ domainState?.registered ? "Registered in Poste.io" : "Not registered in Poste.io" }}
            · {{ dnsComplete ? "DNS complete" : `${pendingCount} DNS changes pending` }}
          </p>
        </div>
        <div class="toolbar-actions">
          <button class="button ghost" :disabled="!status?.webmailUrl" @click="openUrl(status?.webmailUrl)">
            Webmail <ExternalLink :size="16" />
          </button>
          <button class="button ghost" :disabled="!status?.adminUrl" @click="openUrl(status?.adminUrl)">
            Admin <ExternalLink :size="16" />
          </button>
          <button class="icon-button large" title="Refresh" @click="load">
            <RefreshCw :size="18" :class="{ spinning: loading }" />
          </button>
        </div>
      </section>

      <section v-if="selectedZone" class="mail-grid">
        <div class="section-panel">
          <div class="section-heading">
            <div><h2>Mail DNS</h2><p>Records recommended by your Poste.io server.</p></div>
            <Send :size="21" class="heading-icon" />
          </div>
          <label class="field">
            <span>DMARC report email</span>
            <input v-model.trim="dmarcEmail" type="email" @change="load" />
          </label>
          <div class="dns-gap-list">
            <div
              v-for="(gap, key) in dnsState?.gaps || {}"
              :key="key"
              class="dns-gap-row"
            >
              <CheckCircle2 v-if="gap.status === 'present'" :size="17" class="ok" />
              <CircleAlert v-else :size="17" class="warn" />
              <span><strong>{{ gap.label }}</strong><small>{{ gap.host }}</small></span>
              <code :title="gap.desired">{{ gap.desired }}</code>
              <em :class="gap.status">{{ gap.status }}</em>
            </div>
            <p v-if="!dnsState?.gaps && !loading" class="empty-inline">DNS status is unavailable.</p>
          </div>
          <div class="panel-actions">
            <button
              class="button secondary"
              :disabled="loading || dnsComplete"
              @click="setup(false)"
            >
              Apply pending DNS
            </button>
            <button
              class="button primary"
              :disabled="loading || (dnsComplete && domainState?.registered)"
              @click="setup(true)"
            >
              <WandSparkles :size="17" /> Full setup
            </button>
            <button
              v-if="!domainState?.registered"
              class="button ghost"
              :disabled="loading"
              @click="registerDomain"
            >
              Register only
            </button>
          </div>
        </div>

        <div class="section-panel">
          <div class="section-heading">
            <div><h2>Mailboxes</h2><p>Accounts on {{ selectedZone.name }}.</p></div>
            <button
              class="button primary compact"
              :disabled="!domainState?.registered"
              @click="mailboxModal = true"
            >
              <Plus :size="16" /> New mailbox
            </button>
          </div>
          <div class="mailbox-list">
            <div v-if="!mailboxes.length" class="empty-inline">No mailboxes yet.</div>
            <div v-for="mailbox in mailboxes" :key="mailbox.address" class="mailbox-row">
              <span class="mail-avatar">{{ mailbox.address.slice(0, 1).toUpperCase() }}</span>
              <span><strong>{{ mailbox.address }}</strong><small>{{ mailbox.name || "Mailbox" }}</small></span>
              <button class="icon-button" title="Reset password" @click="resetPassword(mailbox.address)">
                <KeyRound :size="16" />
              </button>
              <button class="icon-button danger" title="Delete mailbox" @click="deleteMailbox(mailbox.address)">
                <Trash2 :size="16" />
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="table-panel">
        <div class="table-tools">
          <strong>Poste.io domains</strong>
          <span>{{ overview?.domains?.length || 0 }} domains</span>
        </div>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Domain</th><th>DNS zone</th><th>Mailboxes</th><th>Status</th></tr></thead>
            <tbody>
              <tr v-if="!overview?.domains?.length"><td colspan="4" class="empty-state">No domains registered.</td></tr>
              <tr v-for="domain in overview?.domains || []" :key="domain.name">
                <td><strong>{{ domain.name }}</strong></td>
                <td>{{ domain.zoneId ? "Linked" : "Not found" }}</td>
                <td>{{ domain.mailboxCount }}</td>
                <td><span class="row-status" :class="{ issue: domain.disabled }">{{ domain.disabled ? "Disabled" : "Active" }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <BaseModal v-if="mailboxModal" title="Create mailbox" @close="mailboxModal = false">
      <form class="modal-form" @submit.prevent="createMailbox">
        <label class="field">
          <span>Address</span>
          <div class="joined-input">
            <input v-model.trim="mailboxForm.local" placeholder="info" required />
            <span>@{{ selectedZone.name }}</span>
          </div>
        </label>
        <label class="field"><span>Display name</span><input v-model.trim="mailboxForm.name" placeholder="Info desk" /></label>
        <label class="check-control">
          <input v-model="mailboxForm.generate" type="checkbox" />
          Generate a secure password
        </label>
        <label v-if="!mailboxForm.generate" class="field">
          <span>Password</span>
          <input v-model="mailboxForm.password" type="password" minlength="8" required />
        </label>
        <div class="modal-actions">
          <button class="button ghost" type="button" @click="mailboxModal = false">Cancel</button>
          <button class="button primary" :disabled="loading">Create mailbox</button>
        </div>
      </form>
    </BaseModal>
  </div>
</template>
