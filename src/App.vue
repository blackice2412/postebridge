<script setup>
import { computed, onMounted, ref } from "vue";
import {
  ChevronDown,
  Globe2,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  Network,
  RadioTower,
  RotateCcw,
  Settings,
  X,
} from "@lucide/vue";
import { api, withConnection } from "./api.js";
import DnsView from "./components/DnsView.vue";
import LoginScreen from "./components/LoginScreen.vue";
import MailView from "./components/MailView.vue";
import OverviewView from "./components/OverviewView.vue";
import PropagationView from "./components/PropagationView.vue";
import ReverseDnsView from "./components/ReverseDnsView.vue";
import SettingsView from "./components/SettingsView.vue";

const checkingAuth = ref(true);
const authenticated = ref(false);
const profile = ref({ username: "" });
const settings = ref({
  activeConnectionId: "",
  connections: [],
  poste: { configured: false, baseUrl: "http://poste", adminEmail: "", mailHost: "" },
});
const activeConnectionId = ref("");
const view = ref("overview");
const zones = ref([]);
const records = ref([]);
const selectedZoneId = ref("");
const loading = ref(false);
const busy = ref(false);
const sidebarOpen = ref(false);
const toast = ref(null);
let toastTimer;

const selectedZone = computed(() =>
  zones.value.find((zone) => String(zone.id) === String(selectedZoneId.value))
);
const activeConnection = computed(() =>
  settings.value.connections.find(
    (connection) => connection.id === activeConnectionId.value
  )
);
const provider = computed(() => activeConnection.value?.provider || "");
const providerConfigured = computed(() => Boolean(activeConnection.value?.configured));
const providerLabel = computed(() =>
  activeConnection.value?.name || "DNS connection"
);
const pageMeta = computed(
  () =>
    ({
      overview: ["Overview", "Monitor connections and continue setup"],
      dns: ["DNS Zones", "Manage records across your connected providers"],
      mail: ["Mail Domains", "Connect DNS zones to Poste.io and manage mailboxes"],
      propagation: ["Propagation", "Verify DNS across public resolvers"],
      rdns: ["Reverse DNS", "Manage PTR records for outbound mail"],
      settings: ["Settings", "Connections, credentials, and profile"],
    })[view.value]
);
const navItems = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "dns", label: "DNS Zones", icon: Globe2 },
  { id: "mail", label: "Mail Domains", icon: Mail },
  { id: "propagation", label: "Propagation", icon: RadioTower },
  { id: "rdns", label: "Reverse DNS", icon: RotateCcw },
  { id: "settings", label: "Settings", icon: Settings },
];

function notify(message, type = "success") {
  clearTimeout(toastTimer);
  toast.value = { message, type };
  toastTimer = setTimeout(() => {
    toast.value = null;
  }, 6000);
}

function navigate(nextView) {
  view.value = nextView;
  sidebarOpen.value = false;
}

async function bootstrap() {
  checkingAuth.value = true;
  try {
    const session = await api("/api/auth/me");
    if (!session.authenticated) {
      authenticated.value = false;
      return;
    }
    profile.value = session;
    authenticated.value = true;
    if (window.location.pathname === "/login") {
      window.history.replaceState(null, "", "/");
    }
    await loadSettings();
    await loadZones();
  } catch (err) {
    if (err.status === 401) authenticated.value = false;
    else notify(err.message, "error");
  } finally {
    checkingAuth.value = false;
  }
}

async function loadSettings() {
  settings.value = await api("/api/settings");
  activeConnectionId.value = settings.value.activeConnectionId;
}

async function loadZones(preferredZoneId) {
  if (!providerConfigured.value) {
    zones.value = [];
    records.value = [];
    selectedZoneId.value = "";
    return;
  }
  loading.value = true;
  try {
    const data = await api(
      withConnection("/api/zones", activeConnectionId.value)
    );
    zones.value = data.zones || [];
    const availableIds = new Set(zones.value.map((zone) => String(zone.id)));
    const candidate =
      preferredZoneId ||
      (availableIds.has(String(selectedZoneId.value)) ? selectedZoneId.value : "") ||
      zones.value[0]?.id ||
      "";
    selectedZoneId.value = candidate;
    await loadRecords();
  } catch (err) {
    zones.value = [];
    records.value = [];
    notify(err.message, "error");
  } finally {
    loading.value = false;
  }
}

async function loadRecords() {
  records.value = [];
  if (!selectedZoneId.value) return;
  loading.value = true;
  try {
    const data = await api(
      withConnection(
        `/api/zones/${encodeURIComponent(selectedZoneId.value)}/rrsets`,
        activeConnectionId.value
      )
    );
    records.value = data.rrsets || [];
  } catch (err) {
    notify(err.message, "error");
  } finally {
    loading.value = false;
  }
}

async function selectZone(zoneId) {
  selectedZoneId.value = zoneId;
  await loadRecords();
}

async function switchConnection(event) {
  const previousConnectionId = settings.value.activeConnectionId;
  activeConnectionId.value = event.target.value;
  busy.value = true;
  try {
    settings.value = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ activeConnectionId: activeConnectionId.value }),
    });
    selectedZoneId.value = "";
    await loadZones();
  } catch (err) {
    activeConnectionId.value = previousConnectionId;
    notify(err.message, "error");
  } finally {
    busy.value = false;
  }
}

async function saveSettings(payload) {
  busy.value = true;
  try {
    const data = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    const { mailboxPasswordSynced, ...publicSettings } = data;
    settings.value = publicSettings;
    activeConnectionId.value = settings.value.activeConnectionId;
    notify(
      mailboxPasswordSynced
        ? "Settings saved. Matching mailbox password updated on Poste.io."
        : "Settings saved"
    );
    await loadZones();
  } catch (err) {
    notify(err.message, "error");
  } finally {
    busy.value = false;
  }
}

async function addConnection(payload, callbacks = {}) {
  busy.value = true;
  try {
    const created = await api("/api/connections", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    settings.value = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ activeConnectionId: created.connection.id }),
    });
    activeConnectionId.value = created.connection.id;
    notify(`${created.connection.name} connected`);
    await loadZones();
    callbacks.onSuccess?.(created.connection);
  } catch (err) {
    notify(err.message, "error");
    callbacks.onError?.(err.message);
  } finally {
    busy.value = false;
  }
}

async function deleteConnection(connectionId) {
  busy.value = true;
  try {
    settings.value = await api(
      `/api/connections/${encodeURIComponent(connectionId)}`,
      { method: "DELETE" }
    );
    activeConnectionId.value = settings.value.activeConnectionId;
    notify("Connection removed");
    await loadZones();
  } catch (err) {
    notify(err.message, "error");
  } finally {
    busy.value = false;
  }
}

async function saveProfile(payload) {
  busy.value = true;
  try {
    profile.value = await api("/api/profile", {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    notify("Profile updated");
  } catch (err) {
    notify(err.message, "error");
  } finally {
    busy.value = false;
  }
}

async function logout() {
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
  });
  authenticated.value = false;
  profile.value = { username: "" };
  window.history.replaceState(null, "", "/login");
}

async function authenticatedFromLogin(nextProfile) {
  profile.value = nextProfile;
  authenticated.value = true;
  window.history.replaceState(null, "", "/");
  await loadSettings();
  await loadZones();
}

onMounted(bootstrap);
</script>

<template>
  <div v-if="checkingAuth" class="app-loader">
    <div class="brand-mark"><Network :size="23" /></div>
    <span>Loading PosteBridge...</span>
  </div>

  <LoginScreen
    v-else-if="!authenticated"
    @authenticated="authenticatedFromLogin"
  />

  <div v-else class="app-shell">
    <aside class="sidebar" :class="{ open: sidebarOpen }">
      <div class="sidebar-brand">
        <div class="brand-mark"><Network :size="23" /></div>
        <strong>PosteBridge</strong>
        <button class="mobile-close" @click="sidebarOpen = false"><X :size="20" /></button>
      </div>
      <nav>
        <button
          v-for="item in navItems"
          :key="item.id"
          :class="{ active: view === item.id }"
          @click="navigate(item.id)"
        >
          <component :is="item.icon" :size="19" />
          {{ item.label }}
        </button>
      </nav>
      <div class="sidebar-status">
        <span :class="{ online: providerConfigured }"></span>
        <div>
          <strong>{{ providerConfigured ? "Provider connected" : "Setup required" }}</strong>
          <small>{{ settings.poste.configured ? "Poste.io connected" : "Poste.io not configured" }}</small>
        </div>
      </div>
      <button class="signout-button" @click="logout">
        <LogOut :size="17" /> Sign out
      </button>
    </aside>

    <div v-if="sidebarOpen" class="mobile-overlay" @click="sidebarOpen = false"></div>

    <section class="workspace">
      <header class="topbar">
        <button class="menu-button" @click="sidebarOpen = true"><Menu :size="21" /></button>
        <div class="topbar-spacer"></div>
        <label class="provider-control">
          <span>Active connection</span>
          <div>
            <span class="provider-mark" :class="provider">{{ provider === "hetzner" ? "H" : "H" }}</span>
            <select :value="activeConnectionId" :disabled="busy" @change="switchConnection">
              <option v-if="!settings.connections.length" value="">No connections</option>
              <option
                v-for="connection in settings.connections"
                :key="connection.id"
                :value="connection.id"
              >
                {{ connection.name }} · {{ connection.provider }}
              </option>
            </select>
            <ChevronDown :size="15" />
          </div>
        </label>
        <button class="profile-control" @click="navigate('settings')">
          <span>{{ profile.username?.slice(0, 2).toUpperCase() }}</span>
          <strong>{{ profile.username }}</strong>
          <ChevronDown :size="15" />
        </button>
      </header>

      <main>
        <header class="page-heading">
          <div>
            <h1>{{ pageMeta[0] }}</h1>
            <p>{{ pageMeta[1] }}</p>
          </div>
          <div v-if="!providerConfigured && view !== 'settings'" class="setup-callout">
            {{ providerLabel }} is not configured.
            <button @click="navigate('settings')">Open settings</button>
          </div>
        </header>

        <OverviewView
          v-if="view === 'overview'"
          :settings="settings"
          :zones="zones"
          :provider="provider"
          :selected-zone="selectedZone"
          @navigate="navigate"
        />
        <DnsView
          v-else-if="view === 'dns'"
          :provider="provider"
          :connection-id="activeConnectionId"
          :zones="zones"
          :selected-zone-id="selectedZoneId"
          :records="records"
          :loading="loading"
          @select-zone="selectZone"
          @refresh="loadZones"
          @reload="loadRecords"
          @notify="notify"
        />
        <MailView
          v-else-if="view === 'mail'"
          :provider="provider"
          :connection-id="activeConnectionId"
          :zones="zones"
          :selected-zone-id="selectedZoneId"
          :selected-zone="selectedZone"
          :poste-configured="settings.poste.configured"
          @notify="notify"
          @open-settings="navigate('settings')"
          @select-zone="selectZone"
        />
        <PropagationView
          v-else-if="view === 'propagation'"
          :zones="zones"
          :connection-id="activeConnectionId"
          :selected-zone="selectedZone"
          :records="records"
          @notify="notify"
        />
        <ReverseDnsView
          v-else-if="view === 'rdns'"
          :provider="provider"
          :connection-id="activeConnectionId"
          :selected-zone="selectedZone"
          @notify="notify"
        />
        <SettingsView
          v-else
          :settings="settings"
          :profile="profile"
          :busy="busy"
          @save-settings="saveSettings"
          @add-connection="addConnection"
          @delete-connection="deleteConnection"
          @save-profile="saveProfile"
        />
      </main>
    </section>

    <transition name="toast">
      <div v-if="toast" class="toast" :class="toast.type">
        {{ toast.message }}
        <button @click="toast = null"><X :size="15" /></button>
      </div>
    </transition>
  </div>
</template>
