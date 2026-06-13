<script setup>
import { ref } from "vue";
import { ArrowRight, LockKeyhole, Network } from "@lucide/vue";
import { api } from "../api.js";

const emit = defineEmits(["authenticated"]);
const username = ref("root");
const password = ref("");
const loading = ref(false);
const error = ref("");

async function login() {
  loading.value = true;
  error.value = "";
  try {
    const profile = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: username.value, password: password.value }),
    });
    emit("authenticated", profile);
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-brand">
      <div class="brand-mark large"><Network :size="30" /></div>
      <h1>PosteBridge</h1>
      <p>DNS and mail operations, in one private control plane.</p>
      <div class="login-signal">
        <span></span>
        Credentials and provider settings stay on your server
      </div>
    </section>

    <form class="login-card" @submit.prevent="login">
      <div class="login-icon"><LockKeyhole :size="22" /></div>
      <h2>Sign in</h2>
      <p>Use the first-run credentials printed in the container logs.</p>
      <label class="field">
        <span>Username</span>
        <input v-model.trim="username" autocomplete="username" required />
      </label>
      <label class="field">
        <span>Password</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          autofocus
        />
      </label>
      <p v-if="error" class="form-error">{{ error }}</p>
      <button class="button primary login-submit" :disabled="loading">
        {{ loading ? "Signing in..." : "Sign in" }}
        <ArrowRight :size="17" />
      </button>
    </form>
  </main>
</template>
