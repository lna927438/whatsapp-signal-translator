<script setup lang="ts">
defineProps<{ active?: boolean; busy?: boolean; unread?: number }>()
const emit = defineEmits<{ select: [] }>()
</script>

<template>
  <button type="button" class="platform-entry compact-tool google-voice-launcher" :class="{ active }" :disabled="busy" :aria-busy="busy" :aria-pressed="active" aria-label="Google Voice" title="Google Voice" @click="emit('select')">
    <img :src="'./google-voice.svg'" alt="" />
    <span v-if="unread" class="unread-badge">{{ unread > 99 ? '99+' : unread }}</span>
  </button>
</template>

<style scoped>
.google-voice-launcher:disabled { opacity: .55; cursor: progress; }
</style>
