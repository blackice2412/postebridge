<script setup>
import { reactive, ref, watch } from "vue";
import {
  CheckCircle2,
  KeyRound,
  Mail,
  Save,
  ShieldCheck,
  UserRound,
} from "@lucide/vue";

const props = defineProps({
  settings: { type: Object, required: true },
  profile: { type: Object, required: true },
  busy: Boolean,
});
const emit = defineEmits(["save-settings", "save-profile"]);

const providerForm = reactive({
  hetznerKey: "",
  hostingerToken: "",
  posteBaseUrl: "",
  posteAdminEmail: "",
  posteAdminPassword: "",
  posteMailHost: "",
});
const profileForm = reactive({
  username: "",
  currentPassword: "",
  newPassword: "",
  confirmPassword: "",
});
const profileError = ref("");

watch(
  () => props.settings,
  (value) => {
    providerForm.posteBaseUrl = value.poste?.baseUrl || "http://poste";
    providerForm.posteAdminEmail = value.poste?.adminEmail || "";
    providerForm.posteMailHost = value.poste?.mailHost || "";
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

function saveSettings() {
  const payload = {
    providers: { hetzner: {}, hostinger: {} },
    poste: {
      baseUrl: providerForm.posteBaseUrl,
      adminEmail: providerForm.posteAdminEmail,
      mailHost: providerForm.posteMailHost,
    },
  };
  if (providerForm.hetznerKey) {
    payload.providers.hetzner.apiKey = providerForm.hetznerKey;
  }
  if (providerForm.hostingerToken) {
    payload.providers.hostinger.apiToken = providerForm.hostingerToken;
  }
  if (providerForm.posteAdminPassword) {
    payload.poste.adminPassword = providerForm.posteAdminPassword;
  }
  emit("save-settings", payload);
  providerForm.hetznerKey = "";
  providerForm.hostingerToken = "";
  providerForm.posteAdminPassword = "";
}

function clearSecret(provider) {
  if (provider === "poste") {
    emit("save-settings", { poste: { adminPassword: "" } });
    return;
  }
  const field = provider === "hetzner" ? "apiKey" : "apiToken";
  emit("save-settings", { providers: { [provider]: { [field]: "" } } });
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
    <section class="section-panel">
      <div class="section-heading">
        <div>
          <h2>Connections</h2>
          <p>Provider credentials are encrypted and stored in the persistent app volume.</p>
        </div>
        <ShieldCheck :size="22" class="heading-icon" />
      </div>

      <div class="settings-block">
        <div class="settings-title">
          <div class="service-icon hetzner">H</div>
          <div>
            <h3>Hetzner Cloud</h3>
            <p>DNS zones, cloud servers, and reverse DNS.</p>
          </div>
          <span class="connection-state" :class="{ connected: settings.providers.hetzner.configured }">
            <CheckCircle2 :size="15" />
            {{ settings.providers.hetzner.configured ? "Connected" : "Not configured" }}
          </span>
        </div>
        <label class="field">
          <span>API key</span>
          <input
            v-model="providerForm.hetznerKey"
            type="password"
            autocomplete="new-password"
            :placeholder="settings.providers.hetzner.configured ? 'Enter a new key to replace the saved key' : 'Paste Hetzner API key'"
          />
        </label>
        <button
          v-if="settings.providers.hetzner.configured"
          class="text-button danger-text"
          type="button"
          @click="clearSecret('hetzner')"
        >
          Remove saved key
        </button>
      </div>

      <div class="settings-block">
        <div class="settings-title">
          <div class="service-icon hostinger">H</div>
          <div>
            <h3>Hostinger</h3>
            <p>Domains and DNS records from the Hostinger API.</p>
          </div>
          <span class="connection-state" :class="{ connected: settings.providers.hostinger.configured }">
            <CheckCircle2 :size="15" />
            {{ settings.providers.hostinger.configured ? "Connected" : "Not configured" }}
          </span>
        </div>
        <label class="field">
          <span>API token</span>
          <input
            v-model="providerForm.hostingerToken"
            type="password"
            autocomplete="new-password"
            :placeholder="settings.providers.hostinger.configured ? 'Enter a new token to replace the saved token' : 'Paste Hostinger API token'"
          />
        </label>
        <button
          v-if="settings.providers.hostinger.configured"
          class="text-button danger-text"
          type="button"
          @click="clearSecret('hostinger')"
        >
          Remove saved token
        </button>
      </div>

      <div class="settings-block">
        <div class="settings-title">
          <div class="service-icon poste"><Mail :size="20" /></div>
          <div>
            <h3>Poste.io</h3>
            <p>Mail domains, DKIM, DNS recommendations, and mailboxes.</p>
          </div>
          <span class="connection-state" :class="{ connected: settings.poste.configured }">
            <CheckCircle2 :size="15" />
            {{ settings.poste.configured ? "Connected" : "Not configured" }}
          </span>
        </div>
        <div class="form-grid two">
          <label class="field">
            <span>Base URL</span>
            <input v-model.trim="providerForm.posteBaseUrl" placeholder="http://poste" />
          </label>
          <label class="field">
            <span>Mail hostname</span>
            <input v-model.trim="providerForm.posteMailHost" placeholder="mail.example.com (optional)" />
          </label>
          <label class="field">
            <span>Admin email</span>
            <input v-model.trim="providerForm.posteAdminEmail" type="email" placeholder="admin@example.com" />
          </label>
          <label class="field">
            <span>Admin password</span>
            <input
              v-model="providerForm.posteAdminPassword"
              type="password"
              autocomplete="new-password"
              :placeholder="settings.poste.configured ? 'Enter a new password to replace it' : 'Poste.io admin password'"
            />
          </label>
        </div>
        <button
          v-if="settings.poste.configured"
          class="text-button danger-text"
          type="button"
          @click="clearSecret('poste')"
        >
          Remove saved Poste password
        </button>
      </div>

      <div class="panel-actions end">
        <button class="button primary" type="button" :disabled="busy" @click="saveSettings">
          <Save :size="17" />
          Save connections
        </button>
      </div>
    </section>

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
          <input
            v-model="profileForm.confirmPassword"
            type="password"
            autocomplete="new-password"
          />
        </label>
        <p v-if="profileError" class="form-error">{{ profileError }}</p>
        <button class="button secondary full" :disabled="busy">
          <KeyRound :size="17" />
          Update profile
        </button>
      </form>
    </section>
  </div>
</template>
