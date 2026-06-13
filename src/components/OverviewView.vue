<script setup>
import { ArrowRight, CheckCircle2, CircleAlert, Mail, Server, Waypoints } from "@lucide/vue";

defineProps({
  settings: { type: Object, required: true },
  zones: { type: Array, required: true },
  provider: { type: String, required: true },
  selectedZone: Object,
});
defineEmits(["navigate"]);
</script>

<template>
  <div class="overview-stack">
    <section class="welcome-panel">
      <div>
        <h2>Your infrastructure at a glance</h2>
        <p>Connect a DNS provider, select a zone, then apply and verify mail records from the same workspace.</p>
      </div>
      <button class="button primary" @click="$emit('navigate', 'dns')">
        Open DNS zones <ArrowRight :size="17" />
      </button>
    </section>

    <section class="metric-strip">
      <div class="metric-item">
        <Waypoints :size="20" />
        <div><strong>{{ zones.length }}</strong><span>Zones on {{ provider }}</span></div>
      </div>
      <div class="metric-item">
        <component
          :is="settings.providers[provider]?.configured ? CheckCircle2 : CircleAlert"
          :size="20"
        />
        <div>
          <strong>{{ settings.providers[provider]?.configured ? "Connected" : "Action needed" }}</strong>
          <span>DNS provider</span>
        </div>
      </div>
      <div class="metric-item">
        <Mail :size="20" />
        <div><strong>{{ settings.poste.configured ? "Connected" : "Not configured" }}</strong><span>Poste.io</span></div>
      </div>
      <div class="metric-item">
        <Server :size="20" />
        <div><strong>{{ selectedZone?.name || "None" }}</strong><span>Active zone</span></div>
      </div>
    </section>

    <section class="section-panel">
      <div class="section-heading">
        <div><h2>Setup checklist</h2><p>The minimum required for a working deployment.</p></div>
      </div>
      <div class="checklist">
        <button class="check-row" @click="$emit('navigate', 'settings')">
          <CheckCircle2 v-if="settings.providers.hetzner.configured || settings.providers.hostinger.configured" :size="19" class="ok" />
          <CircleAlert v-else :size="19" class="warn" />
          <span><strong>Connect a DNS provider</strong><small>Hetzner Cloud or Hostinger API access</small></span>
          <ArrowRight :size="17" />
        </button>
        <button class="check-row" @click="$emit('navigate', 'settings')">
          <CheckCircle2 v-if="settings.poste.configured" :size="19" class="ok" />
          <CircleAlert v-else :size="19" class="warn" />
          <span><strong>Connect Poste.io</strong><small>Use the bundled service URL and your Poste admin login</small></span>
          <ArrowRight :size="17" />
        </button>
        <button class="check-row" @click="$emit('navigate', 'mail')">
          <CheckCircle2 v-if="selectedZone" :size="19" class="ok" />
          <CircleAlert v-else :size="19" class="warn" />
          <span><strong>Configure a mail domain</strong><small>Apply MX, SPF, DKIM, DMARC, and client discovery records</small></span>
          <ArrowRight :size="17" />
        </button>
      </div>
    </section>
  </div>
</template>
