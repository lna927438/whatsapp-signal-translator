<script setup lang="ts">
defineProps<{ name: string }>()
const paths: Record<string, string> = {
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M9 21h6',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c-5 5-5 13 0 18 M12 3c5 5 5 13 0 18',
  home: 'm3 10 9-7 9 7v10H3Z M9 20v-7h6v7',
  panel: 'M3 4h18v16H3Z M9 4v16 M14 9l3 3-3 3',
  plus: 'M12 5v14 M5 12h14',
  search: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15 M16 16l5 5',
  settings: 'm9 3-.6 2.4-1.5.9-2.4-.7-3 5.2 1.8 1.7v1.8l-1.8 1.7 3 5.2 2.4-.7 1.5.9L9 23h6l.6-2.4 1.5-.9 2.4.7 3-5.2-1.8-1.7v-1.8l1.8-1.7-3-5.2-2.4.7-1.5-.9L15 3Z M12 9a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
  restart: 'M20 7a9 9 0 1 0 1 8 M20 2v6h-6 M12 7v6',
  user: 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M4 21v-2a8 6 0 0 1 16 0v2',
  signal: 'M4 19v-2 M9 19v-6 M14 19V9 M19 19V5',
  refresh: 'M20 8a8 8 0 1 0 0 8 M20 3v5h-5',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  chevron: 'm9 5 7 7-7 7',
  shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z m-4 9 3 3 5-6',
  chat: 'M4 3h16v14H9l-5 4Z M8 8h8 M8 12h5'
}
</script>
<template><svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.chat" /></svg></template>
