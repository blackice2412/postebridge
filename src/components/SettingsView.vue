<script setup>
import { reactive, ref, watch } from "vue";
import {
  CheckCircle2,
  Database,
  KeyRound,
  Mail,
  Plus,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Trash2,
  UserRound,
} from "@lucide/vue";
import { api } from "../api.js";
import BaseModal from "./BaseModal.vue";

const props = defineProps({
  settings: { type: Object, required: true },
  profile: { type: Object, required: true },
  busy: Boolean,
});
const emit = defineEmits([
  "save-settings",
  "add-connection",
  "delete-connection",
  "save-profile",
]);

const connectionModal = ref(false);
const connectionError = ref("");
const details = reactive({});
const loadingDetails = reactive({});
const connectionForm = reactive({
  name: "",
  provider: "hetzner",
  apiKey: "",
});
const posteForm = reactive({
  baseUrl: "",
  adminEmail: "",
  adminPassword: "",
  mailHost: "",
});
const profileForm = reactive({
  username: "",
  currentPassword: "",
  newPassword: "",
  confirmPassword: "",
});
const profileError = ref("");
const posteDetails = ref(null);
const loadingPosteDetails = ref(false);

watch(
  () => props.settings,
  (value) => {
    posteForm.baseUrl = value.poste?.baseUrl || "http://poste";
    posteForm.adminEmail = value.poste?.adminEmail || "";
    posteForm.mailHost = value.poste?.mailHost || "";
    if (value.poste?.configured) {
      loadPosteDetails();
    } else {
      posteDetails.value = null;
    }
    for (const connection of value.connections || []) {
      if (!details[connection.id] && !loadingDetails[connection.id]) {
        loadDetails(connection.id);
      }
    }
  },
  { immediate: true, deep: true }
);

watch(
  () => props.profile,
  (value) => {
    profileForm.username = value.username || "";
  },
  { immediate: true, deep: true }
);

async function loadPosteDetails() {
  if (!props.settings.poste?.configured) {
    posteDetails.value = null;
    return;
  }
  loadingPosteDetails.value = true;
  try {
    posteDetails.value = await api("/api/poste/details");
  } catch (err) {
    posteDetails.value = { error: err.message };
  } finally {
    loadingPosteDetails.value = false;
  }
}

async function loadDetails(connectionId) {
  loadingDetails[connectionId] = true;
  try {
    details[connectionId] = await api(
      `/api/connections/${encodeURIComponent(connectionId)}/details`
    );
  } catch (err) {
    details[connectionId] = { error: err.message };
  } finally {
    loadingDetails[connectionId] = false;
  }
}

function addConnection() {
  connectionError.value = "";
  emit(
    "add-connection",
    {
      name: connectionForm.name,
      provider: connectionForm.provider,
      apiKey: connectionForm.apiKey,
    },
    {
      onSuccess(connection) {
        connectionModal.value = false;
        connectionForm.name = "";
        connectionForm.provider = "hetzner";
        connectionForm.apiKey = "";
        loadDetails(connection.id);
      },
      onError(message) {
        connectionError.value = message;
      },
    }
  );
}

function removeConnection(connection) {
  if (!window.confirm(`Remove connection "${connection.name}"?`)) return;
  emit("delete-connection", connection.id);
}

function savePoste() {
  const poste = {
    baseUrl: posteForm.baseUrl,
    adminEmail: posteForm.adminEmail,
    mailHost: posteForm.mailHost,
  };
  if (posteForm.adminPassword) poste.adminPassword = posteForm.adminPassword;
  emit("save-settings", { poste });
  posteForm.adminPassword = "";
}

function clearPostePassword() {
  emit("save-settings", { poste: { adminPassword: "" } });
}

function saveProfile() {
  profileError.value = "";
  if (profileForm.newPassword !== profileForm.confirmPassword) {
    profileError.value = "New passwords do not match";
    return;
  }
  emit("save-profile", {
    username: profileForm.username,
    currentPassword: profileForm.currentPassword,
    newPassword: profileForm.newPassword || undefined,
  });
  profileForm.currentPassword = "";
  profileForm.newPassword = "";
  profileForm.confirmPassword = "";
}
</script>

<template>
  <div class="settings-layout">
    <div class="settings-main">
      <section class="section-panel">
        <div class="section-heading">
          <div>
            <h2>DNS connections</h2>
            <p>Add as many named Hetzner or Hostinger accounts as you need.</p>
          </div>
          <button class="button primary compact" type="button" @click="connectionModal = true">
            <Plus :size="16" /> Add connection
          </button>
        </div>

        <div v-if="!settings.connections.length" class="empty-inline">
          No DNS connections added yet.
        </div>
        <div class="connection-list">
          <article
            v-for="connection in settings.connections"
            :key="connection.id"
            class="connection-card"
            :class="{ active: connection.id === settings.activeConnectionId }"
          >
            <div class="connection-card-head">
              <div class="service-icon" :class="connection.provider">H</div>
              <div>
                <h3>{{ connection.name }}</h3>
                <p class="capitalize">{{ connection.provider }} API</p>
              </div>
              <span
                class="connection-state connected"
                :title="connection.id === settings.activeConnectionId ? 'Active connection' : 'Connected'"
              >
                <CheckCircle2 :size="15" />
                {{ connection.id === settings.activeConnectionId ? "Active" : "Connected" }}
              </span>
              <button
                class="icon-button danger"
                type="button"
                title="Remove connection"
                @click="removeConnection(connection)"
              >
                <Trash2 :size="16" />
              </button>
            </div>

            <div v-if="loadingDetails[connection.id]" class="connection-loading">
              <RefreshCw :size="15" class="spinning" /> Reading account details...
            </div>
            <div v-else-if="details[connection.id]?.error" class="connection-error">
              {{ details[connection.id].error }}
              <button class="text-button" @click="loadDetails(connection.id)">Retry</button>
            </div>
            <div v-else class="account-facts">
              <span>
                <Database :size="16" />
                <strong>{{ details[connection.id]?.zoneCount ?? "-" }}</strong>
                zones
              </span>
              <span v-if="connection.provider === 'hetzner'">
                <Server :size="16" />
                <strong>{{ details[connection.id]?.serverCount ?? "-" }}</strong>
                servers
              </span>
              <span v-else>
                <ShieldCheck :size="16" />
                <strong>{{ details[connection.id]?.activeDomainCount ?? "-" }}</strong>
                active domains
              </span>
              <button class="icon-button" title="Refresh account details" @click="loadDetails(connection.id)">
                <RefreshCw :size="15" />
              </button>
            </div>
            <p v-if="details[connection.id]?.zones?.length" class="account-resource-list">
              {{ details[connection.id].zones.join(", ") }}
            </p>
          </article>
        </div>
      </section>

      <section class="section-panel">
        <div class="section-heading">
          <div>
            <h2>Poste.io connection</h2>
            <p>Mail domains, DKIM, DNS recommendations, and mailboxes.</p>
          </div>
          <Mail :size="22" class="heading-icon" />
        </div>
        <div class="form-grid two">
          <label class="field">
            <span>Base URL</span>
            <input v-model.trim="posteForm.baseUrl" placeholder="http://poste" />
          </label>
          <label class="field">
            <span>Mail hostname</span>
            <input v-model.trim="posteForm.mailHost" placeholder="mail.example.com (optional)" />
          </label>
          <label class="field">
            <span>Admin email</span>
            <input v-model.trim="posteForm.adminEmail" type="email" placeholder="admin@example.com" />
          </label>
          <label class="field">
            <span>Admin password</span>
            <input
              v-model="posteForm.adminPassword"
              type="password"
              autocomplete="new-password"
              :placeholder="settings.poste.configured ? 'Enter a new password to replace it' : 'Poste.io admin password'"
            />
          </label>
        </div>
        <div v-if="settings.poste.configured" class="poste-status">
          <div v-if="loadingPosteDetails" class="connection-loading">
            <RefreshCw :size="15" class="spinning" /> Checking Poste.io connection...
          </div>
          <div v-else-if="posteDetails?.error" class="connection-error">
            {{ posteDetails.error }}
            <button class="text-button" type="button" @click="loadPosteDetails">Retry</button>
          </div>
          <div v-else-if="posteDetails" class="account-facts">
            <span>
              <Mail :size="16" />
              <strong>{{ posteDetails.domainCount ?? "-" }}</strong>
              Poste domains
            </span>
            <button class="icon-button" title="Refresh Poste.io status" type="button" @click="loadPosteDetails">
              <RefreshCw :size="15" />
            </button>
          </div>
          <p v-if="posteDetails?.domains?.length" class="account-resource-list">
            {{ posteDetails.domains.join(", ") }}
          </p>
        </div>
        <div class="panel-actions">
          <button
            v-if="settings.poste.configured"
            class="text-button danger-text"
            type="button"
            @click="clearPostePassword"
          >
            Remove saved Poste password
          </button>
          <button class="button primary" type="button" :disabled="busy" @click="savePoste">
            <Save :size="17" /> Save Poste.io
          </button>
        </div>
      </section>
    </div>

    <section class="section-panel profile-panel">
      <div class="section-heading">
        <div>
          <h2>Profile</h2>
          <p>Change the dashboard username or password.</p>
        </div>
        <UserRound :size="22" class="heading-icon" />
      </div>
      <form @submit.prevent="saveProfile">
        <label class="field">
          <span>Username</span>
          <input v-model.trim="profileForm.username" minlength="3" required />
        </label>
        <label class="field">
          <span>Current password</span>
          <input v-model="profileForm.currentPassword" type="password" autocomplete="current-password" required />
        </label>
        <label class="field">
          <span>New password</span>
          <input
            v-model="profileForm.newPassword"
            type="password"
            minlength="12"
            autocomplete="new-password"
            placeholder="Leave blank to keep current password"
          />
        </label>
        <label class="field">
          <span>Confirm new password</span>
          <input v-model="profileForm.confirmPassword" type="password" autocomplete="new-password" />
        </label>
        <p v-if="profileError" class="form-error">{{ profileError }}</p>
        <button class="button secondary full" :disabled="busy">
          <KeyRound :size="17" /> Update profile
        </button>
      </form>
    </section>

    <BaseModal v-if="connectionModal" title="Add DNS connection" @close="connectionModal = false">
      <form class="modal-form" @submit.prevent="addConnection">
        <label class="field">
          <span>Connection name</span>
          <input v-model.trim="connectionForm.name" placeholder="Production Hetzner" required />
        </label>
        <label class="field">
          <span>Provider</span>
          <select v-model="connectionForm.provider">
            <option value="hetzner">Hetzner</option>
            <option value="hostinger">Hostinger</option>
          </select>
        </label>
        <label class="field">
          <span>{{ connectionForm.provider === "hetzner" ? "API key" : "API token" }}</span>
          <input
            v-model="connectionForm.apiKey"
            type="password"
            autocomplete="new-password"
            :placeholder="connectionForm.provider === 'hetzner' ? 'Paste Hetzner API key' : 'Paste Hostinger API token'"
            required
          />
        </label>
        <p class="field-note">
          The credential is verified before it is encrypted and saved.
        </p>
        <p v-if="connectionError" class="form-error">{{ connectionError }}</p>
        <div class="modal-actions">
          <button class="button ghost" type="button" @click="connectionModal = false">Cancel</button>
          <button class="button primary" :disabled="busy">
            {{ busy ? "Checking..." : "Add connection" }}
          </button>
        </div>
      </form>
    </BaseModal>
  </div>
</template>
