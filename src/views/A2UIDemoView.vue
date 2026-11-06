<script setup lang="ts">
/**
 * A2UI 组件展示 Demo 页面
 * 展示所有 18 种 A2UI 组件的渲染效果
 */
import { reactive } from 'vue'
import { A2UIRenderer } from '../components/a2ui'
import type { A2UIComponent } from '../components/a2ui'

/** 示例数据模型 */
const dataModel = reactive({
  userName: 'Alice',
  email: '',
  bio: '',
  password: '',
  temperature: 50,
  enableDarkMode: true,
  selectedColor: ['blue'],
  selectedFruits: ['apple'],
  startDate: '',
  items: [
    { name: '项目 A', status: '进行中' },
    { name: '项目 B', status: '已完成' },
    { name: '项目 C', status: '待开始' },
  ],
})

/** 所有示例组件 */
const demoComponents: A2UIComponent[] = [
  // === 根布局 ===
  {
    component: 'Column',
    id: 'root',
    children: [
      'section-display',
      'divider-1',
      'section-layout',
      'divider-2',
      'section-inputs',
      'divider-3',
      'section-composite',
    ],
  },

  // ===== 展示组件区 =====
  {
    component: 'Column',
    id: 'section-display',
    children: ['title-display', 'card-text-demo', 'card-media-demo', 'card-icon-demo'],
  },
  { component: 'Text', id: 'title-display', text: '📖 展示组件', variant: 'h2' },

  // Text 组件展示
  {
    component: 'Card',
    id: 'card-text-demo',
    child: 'text-demo-col',
  },
  {
    component: 'Column',
    id: 'text-demo-col',
    children: ['text-h1', 'text-h3', 'text-body', 'text-caption', 'text-md'],
  },
  { component: 'Text', id: 'text-h1', text: 'H1 标题', variant: 'h1' },
  { component: 'Text', id: 'text-h3', text: 'H3 子标题', variant: 'h3' },
  { component: 'Text', id: 'text-body', text: '正文文本 (body) - 当前用户为 Alice，这是 A2UI 的声明式 JSON UI 渲染系统。' },
  { component: 'Text', id: 'text-caption', text: '这是一段注释文字 (caption)', variant: 'caption' },
  { component: 'Text', id: 'text-md', text: '**支持 Markdown**：`代码`、*斜体*、[链接](https://a2ui.org)' },

  // Image + Video 展示
  {
    component: 'Card',
    id: 'card-media-demo',
    child: 'media-row',
  },
  {
    component: 'Row',
    id: 'media-row',
    children: ['img-avatar', 'img-small', 'img-medium'],
    align: 'center',
    justify: 'start',
  },
  {
    component: 'Image',
    id: 'img-avatar',
    url: 'https://api.dicebear.com/9.x/avataaars/svg?seed=Felix',
    variant: 'avatar',
    fit: 'cover',
  },
  {
    component: 'Image',
    id: 'img-small',
    url: 'https://api.dicebear.com/9.x/shapes/svg?seed=A2UI',
    variant: 'smallFeature',
    fit: 'contain',
  },
  {
    component: 'Image',
    id: 'img-medium',
    url: 'https://api.dicebear.com/9.x/icons/svg?seed=Demo',
    variant: 'mediumFeature',
    fit: 'contain',
  },

  // Icon 展示
  {
    component: 'Card',
    id: 'card-icon-demo',
    child: 'icon-row',
  },
  {
    component: 'Row',
    id: 'icon-row',
    children: [
      'icon-home', 'icon-star', 'icon-fav', 'icon-search',
      'icon-settings', 'icon-mail', 'icon-person', 'icon-check',
      'icon-info', 'icon-warning', 'icon-error', 'icon-play',
    ],
    justify: 'start',
    align: 'center',
  },
  { component: 'Icon', id: 'icon-home', name: 'home' },
  { component: 'Icon', id: 'icon-star', name: 'star' },
  { component: 'Icon', id: 'icon-fav', name: 'favorite' },
  { component: 'Icon', id: 'icon-search', name: 'search' },
  { component: 'Icon', id: 'icon-settings', name: 'settings' },
  { component: 'Icon', id: 'icon-mail', name: 'mail' },
  { component: 'Icon', id: 'icon-person', name: 'person' },
  { component: 'Icon', id: 'icon-check', name: 'check' },
  { component: 'Icon', id: 'icon-info', name: 'info' },
  { component: 'Icon', id: 'icon-warning', name: 'warning' },
  { component: 'Icon', id: 'icon-error', name: 'error' },
  { component: 'Icon', id: 'icon-play', name: 'play' },

  // ===== 布局组件区 =====
  {
    component: 'Column',
    id: 'section-layout',
    children: ['title-layout', 'card-row-demo', 'card-list-demo'],
  },
  { component: 'Text', id: 'title-layout', text: '📐 布局组件', variant: 'h2' },

  // Row 布局
  {
    component: 'Card',
    id: 'card-row-demo',
    child: 'row-demo-col',
  },
  {
    component: 'Column',
    id: 'row-demo-col',
    children: ['row-label', 'row-demo'],
  },
  { component: 'Text', id: 'row-label', text: 'Row 水平布局 (spaceBetween)', variant: 'caption' },
  {
    component: 'Row',
    id: 'row-demo',
    children: ['row-btn1', 'row-btn2', 'row-btn3'],
    justify: 'spaceBetween',
    align: 'center',
  },
  {
    component: 'Button',
    id: 'row-btn1',
    child: 'row-btn1-text',
    variant: 'default',
    action: { event: { name: 'click', context: { button: 'left' } } },
  },
  { component: 'Text', id: 'row-btn1-text', text: '左按钮' },
  {
    component: 'Button',
    id: 'row-btn2',
    child: 'row-btn2-text',
    variant: 'primary',
    action: { event: { name: 'click', context: { button: 'center' } } },
  },
  { component: 'Text', id: 'row-btn2-text', text: '主按钮' },
  {
    component: 'Button',
    id: 'row-btn3',
    child: 'row-btn3-text',
    variant: 'borderless',
    action: { event: { name: 'click', context: { button: 'right' } } },
  },
  { component: 'Text', id: 'row-btn3-text', text: '无边框' },

  // List 布局
  {
    component: 'Card',
    id: 'card-list-demo',
    child: 'list-demo-col',
  },
  {
    component: 'Column',
    id: 'list-demo-col',
    children: ['list-label', 'list-demo'],
  },
  { component: 'Text', id: 'list-label', text: 'List 垂直列表', variant: 'caption' },
  {
    component: 'List',
    id: 'list-demo',
    children: ['list-item1', 'list-item2', 'list-item3'],
    direction: 'vertical',
  },
  {
    component: 'Row',
    id: 'list-item1',
    children: ['list-icon1', 'list-text1'],
    align: 'center',
  },
  { component: 'Icon', id: 'list-icon1', name: 'folder' },
  { component: 'Text', id: 'list-text1', text: '项目 A - 进行中' },
  {
    component: 'Row',
    id: 'list-item2',
    children: ['list-icon2', 'list-text2'],
    align: 'center',
  },
  { component: 'Icon', id: 'list-icon2', name: 'check' },
  { component: 'Text', id: 'list-text2', text: '项目 B - 已完成' },
  {
    component: 'Row',
    id: 'list-item3',
    children: ['list-icon3', 'list-text3'],
    align: 'center',
  },
  { component: 'Icon', id: 'list-icon3', name: 'calendarToday' },
  { component: 'Text', id: 'list-text3', text: '项目 C - 待开始' },

  // Dividers
  { component: 'Divider', id: 'divider-1' },
  { component: 'Divider', id: 'divider-2' },
  { component: 'Divider', id: 'divider-3' },

  // ===== 交互组件区 =====
  {
    component: 'Column',
    id: 'section-inputs',
    children: ['title-inputs', 'card-inputs-demo'],
  },
  { component: 'Text', id: 'title-inputs', text: '🎛️ 交互组件', variant: 'h2' },
  {
    component: 'Card',
    id: 'card-inputs-demo',
    child: 'inputs-col',
  },
  {
    component: 'Column',
    id: 'inputs-col',
    children: [
      'input-name', 'input-email', 'input-bio', 'input-password',
      'input-checkbox', 'input-slider',
      'input-choice-radio', 'input-choice-chips', 'input-choice-select',
      'input-datetime',
    ],
  },
  {
    component: 'TextField',
    id: 'input-name',
    label: '用户名',
    value: { path: '/userName' },
    variant: 'shortText',
  },
  {
    component: 'TextField',
    id: 'input-email',
    label: '邮箱地址',
    value: { path: '/email' },
    variant: 'shortText',
    validationRegexp: '^[\\w.-]+@[\\w.-]+\\.[a-zA-Z]{2,}$',
  },
  {
    component: 'TextField',
    id: 'input-bio',
    label: '个人简介',
    value: { path: '/bio' },
    variant: 'longText',
  },
  {
    component: 'TextField',
    id: 'input-password',
    label: '密码',
    value: { path: '/password' },
    variant: 'obscured',
  },
  {
    component: 'CheckBox',
    id: 'input-checkbox',
    label: '启用深色模式',
    value: { path: '/enableDarkMode' },
  },
  {
    component: 'Slider',
    id: 'input-slider',
    label: '温度调节',
    min: 0,
    max: 100,
    value: { path: '/temperature' },
  },
  {
    component: 'ChoicePicker',
    id: 'input-choice-radio',
    label: '选择颜色（单选 - Radio）',
    variant: 'mutuallyExclusive',
    displayStyle: 'checkbox',
    options: [
      { label: '🔴 红色', value: 'red' },
      { label: '🔵 蓝色', value: 'blue' },
      { label: '🟢 绿色', value: 'green' },
    ],
    value: { path: '/selectedColor' },
  },
  {
    component: 'ChoicePicker',
    id: 'input-choice-chips',
    label: '选择水果（多选 - Chips）',
    variant: 'multipleSelection',
    displayStyle: 'chips',
    filterable: true,
    options: [
      { label: '🍎 苹果', value: 'apple' },
      { label: '🍌 香蕉', value: 'banana' },
      { label: '🍊 橙子', value: 'orange' },
      { label: '🍇 葡萄', value: 'grape' },
      { label: '🍓 草莓', value: 'strawberry' },
    ],
    value: { path: '/selectedFruits' },
  },
  {
    component: 'ChoicePicker',
    id: 'input-choice-select',
    label: '选择大区（单选 - Select 下拉）',
    variant: 'mutuallyExclusive',
    displayStyle: 'select',
    options: [
      { label: '华东', value: 'cn-east' },
      { label: '华北', value: 'cn-north' },
      { label: '华南', value: 'cn-south' },
    ],
    value: { path: '/selectedRegion' },
  },
  {
    component: 'DateTimeInput',
    id: 'input-datetime',
    label: '选择开始日期和时间',
    enableDate: true,
    enableTime: true,
    value: { path: '/startDate' },
  },

  // ===== 复合组件区 =====
  {
    component: 'Column',
    id: 'section-composite',
    children: ['title-composite', 'tabs-demo', 'modal-demo'],
  },
  { component: 'Text', id: 'title-composite', text: '🧩 复合组件', variant: 'h2' },

  // Tabs 组件
  {
    component: 'Tabs',
    id: 'tabs-demo',
    tabs: [
      { title: '概览', child: 'tab-overview' },
      { title: '详情', child: 'tab-details' },
      { title: '设置', child: 'tab-settings' },
    ],
  },
  {
    component: 'Column',
    id: 'tab-overview',
    children: ['tab-overview-text', 'tab-overview-img'],
  },
  { component: 'Text', id: 'tab-overview-text', text: '这是概览选项卡的内容。A2UI 允许 Agent 发送声明式 JSON 来描述 UI 组件树。' },
  {
    component: 'Image',
    id: 'tab-overview-img',
    url: 'https://api.dicebear.com/9.x/shapes/svg?seed=overview',
    variant: 'smallFeature',
  },
  { component: 'Text', id: 'tab-details', text: '这里展示了更多的详细信息。组件支持动态数据绑定、Action 事件、验证规则等功能。' },
  {
    component: 'Column',
    id: 'tab-settings',
    children: ['tab-setting-1', 'tab-setting-2'],
  },
  {
    component: 'CheckBox',
    id: 'tab-setting-1',
    label: '启用通知',
    value: true,
  },
  {
    component: 'Slider',
    id: 'tab-setting-2',
    label: '音量',
    min: 0,
    max: 100,
    value: 75,
  },

  // Modal 组件
  {
    component: 'Modal',
    id: 'modal-demo',
    trigger: 'modal-trigger-btn',
    content: 'modal-content',
  },
  {
    component: 'Button',
    id: 'modal-trigger-btn',
    child: 'modal-trigger-text',
    variant: 'primary',
    action: { event: { name: 'open-modal' } },
  },
  { component: 'Text', id: 'modal-trigger-text', text: '🔓 打开模态框' },
  {
    component: 'Column',
    id: 'modal-content',
    children: ['modal-title', 'modal-body', 'modal-input'],
  },
  { component: 'Text', id: 'modal-title', text: '模态框标题', variant: 'h3' },
  { component: 'Text', id: 'modal-body', text: '这是模态框内容。A2UI 的 Modal 组件通过 trigger 和 content 组件 ID 引用来工作。' },
  {
    component: 'TextField',
    id: 'modal-input',
    label: '在模态框中输入',
    variant: 'shortText',
    value: '',
  },
]

function handleAction(action: any, data: any) {
  console.log('[A2UI Demo] Action:', action, 'DataModel:', JSON.parse(JSON.stringify(data)))
}

function handleDataUpdate(path: string, value: any) {
  console.log('[A2UI Demo] Data Update:', path, '=', value)
}
</script>

<template>
  <div class="h-full overflow-auto p-4 md:p-6 bg-base-200/50">
    <div class="max-w-3xl mx-auto">
      <!-- 页面标题 -->
      <div class="mb-6">
        <h1 class="text-2xl font-bold flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-7 h-7 text-primary">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
          </svg>
          A2UI v1.0 组件展示
        </h1>
        <p class="text-sm text-base-content/60 mt-1">
          基于 a2ui v1.0 协议（a2ui-project/a2ui）的 Vue 渲染器，共 18 种组件
        </p>
      </div>

      <!-- 数据模型实时状态 -->
      <div class="collapse collapse-arrow border border-base-300 bg-base-100 rounded-xl mb-4">
        <input type="checkbox" />
        <div class="collapse-title text-sm font-medium opacity-70">
          📊 实时数据模型 (DataModel)
        </div>
        <div class="collapse-content">
          <pre class="text-xs bg-base-200 rounded-lg p-3 mt-2 overflow-auto max-h-60">{{ JSON.stringify(dataModel, null, 2) }}</pre>
        </div>
      </div>

      <!-- A2UI 渲染器 -->
      <A2UIRenderer
        :components="demoComponents"
        :data-model="dataModel"
        :root-ids="['root']"
        @action="handleAction"
        @update-data="handleDataUpdate"
      />
    </div>
  </div>
</template>
