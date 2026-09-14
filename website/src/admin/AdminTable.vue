<script setup lang="ts">
import type { Row } from './client'
export interface Column {key:string;title:string;format?:(row:Row)=>string;tag?:boolean;mono?:boolean}
defineProps<{rows:Row[];columns:Column[];empty?:string}>()
const emit=defineEmits<{select:[row:Row]}>()
</script>
<template>
  <div class="adm-table-wrap"><table class="adm-table"><thead><tr><th v-for="col in columns" :key="col.key" scope="col">{{ col.title }}</th><th v-if="$slots.actions" scope="col"><span class="adm-sr">操作</span></th></tr></thead>
    <tbody><tr v-for="(row,i) in rows" :key="String(row.id||row.user_id||row.request_id||row.code||row.version||i)">
      <td v-for="col in columns" :key="col.key" :class="{mono:col.mono}"><span :class="col.tag?'adm-tag':''" :data-value="row[col.key]" :title="String(col.format?col.format(row):row[col.key]??'')">{{ col.format?col.format(row):row[col.key]??'暂无' }}</span></td>
      <td v-if="$slots.actions" class="adm-actions"><slot name="actions" :row="row" :select="()=>emit('select',row)" /></td>
    </tr><tr v-if="!rows.length"><td :colspan="columns.length+1" class="adm-empty">{{ empty||'没有符合条件的记录。' }}</td></tr></tbody></table></div>
</template>
