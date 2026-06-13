<script setup>
import { X } from "@lucide/vue";

defineProps({
  title: { type: String, required: true },
  wide: Boolean,
});
defineEmits(["close"]);
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="$emit('close')">
    <section class="modal-card" :class="{ wide }" role="dialog" aria-modal="true">
      <header class="modal-head">
        <h2>{{ title }}</h2>
        <button class="icon-button" type="button" aria-label="Close" @click="$emit('close')">
          <X :size="18" />
        </button>
      </header>
      <slot />
    </section>
  </div>
</template>
