import type { NodeCategory, PortType } from './types'

export const PORT_COLORS: Record<PortType, string> = {
  exec: '#eef0f6',
  any: '#9aa1b4',
  boolean: '#c2556e',
  number: '#3fc1a9',
  string: '#c677cf',
}

export const CATEGORY_COLORS: Record<NodeCategory, string> = {
  event: '#8f2b3b',
  source: '#b06a2b',
  logic: '#3d4250',
  transform: '#1f7a70',
  data: '#2b7a4b',
  variable: '#a0842b',
  asset: '#7a5a2b',
  report: '#a02b6e',
  ui: '#1f6f9e',
  subgraph: '#7a4fa0',
  action: '#2b6ea3',
}

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  event: '事件',
  source: '源',
  logic: '逻辑',
  transform: '处理',
  data: '数据',
  variable: '变量',
  asset: '资产',
  report: '报表',
  ui: '界面',
  subgraph: '子蓝图',
  action: '动作',
}

export const CATEGORY_ORDER: NodeCategory[] = [
  'event',
  'source',
  'logic',
  'transform',
  'ui',
  'variable',
  'asset',
  'report',
  'subgraph',
  'action',
  'data',
]
