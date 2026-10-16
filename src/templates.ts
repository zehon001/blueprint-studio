import type { PluginRecord, SerializedGraph, VariableDef } from './types'

/**
 * 插件模板 —— 类似 UE5 的新建项目模板。
 * 生成即带完整可运行的蓝图，开箱体验。
 */

export type TemplateId = 'logviewer' | 'report' | 'blank'

export const TEMPLATES: { id: TemplateId; name: string; description: string }[] = [
  {
    id: 'logviewer',
    name: '日志查看器',
    description: '流式读取日志源，按 会话/轮次 折叠显示、标签配色、高频日志合并',
  },
  {
    id: 'report',
    name: '报表输出',
    description: '拉取 RDS 统计数据填充模板，运行时展示 Markdown 并可推送飞书',
  },
  { id: 'blank', name: '空白', description: '从零搭建，只有一个开始事件' },
]

function N(
  id: string,
  defId: string,
  x: number,
  y: number,
  params: Record<string, unknown> = {},
): SerializedGraph['nodes'][number] {
  return { id, defId, position: { x, y }, params }
}

function E(
  id: string,
  source: string,
  sourcePort: string,
  target: string,
  targetPort: string,
): SerializedGraph['edges'][number] {
  return { id, source, sourcePort, target, targetPort }
}

function logViewerGraph(): SerializedGraph {
  const nodes = [
    N('srcDemo', 'source/demo', 0, 0, { preset: 'dolphin', rate: 3 }),
    N('srcAdb', 'source/adb', 0, 170, { package: 'packageName', tag: '' }),
    N('srcFile', 'source/file', 0, 340, { asset: '', intervalMs: 120 }),
    N('onlog', 'event/onLogLine', 300, 0, { source: 'srcDemo' }),
    N('mSess', 'transform/regexMatch', 60, 520, {
      pattern: '=== SESSION START (.+) ===',
    }),
    N('bSess', 'logic/branch', 620, 40),
    N('wSess', 'output/logTreeSession', 940, 0, { title: '运行日志' }),
    N('mRound', 'transform/regexMatch', 60, 720, { pattern: '--- ROUND (\\d+) ---' }),
    N('bRound', 'logic/branch', 620, 320),
    N('fmtRound', 'transform/formatText', 320, 940, { template: '第 {1} 轮' }),
    N('wRound', 'output/logTreeRound', 940, 260, { title: '运行日志' }),
    N('mEntry', 'transform/regexMatch', 60, 1000, {
      pattern: '\\[(\\w+)\\] ([\\w.]+): (.*)',
    }),
    N('bEntry', 'logic/branch', 620, 620),
    N('tc', 'transform/tagColor', 320, 1220, {
      map: 'INFO=#3fc1a9\nWARN=#d9a441\nERROR=#e06c75\nDEBUG=#8a94a8',
    }),
    N('fmtEntry', 'transform/formatText', 320, 1400, { template: '{2}: {3}' }),
    N('wEntry', 'output/logTreeEntry', 1240, 480, { title: '运行日志' }),
    N('wRaw', 'output/logTreeEntry', 1240, 800, { title: '运行日志' }),
  ]
  const edges = [
    E('e1', 'onlog', 'exec', 'bSess', 'exec'),
    E('e2', 'mSess', 'matched', 'bSess', 'condition'),
    E('e3', 'bSess', 'true', 'wSess', 'exec'),
    E('e4', 'bSess', 'false', 'bRound', 'exec'),
    E('e5', 'mRound', 'matched', 'bRound', 'condition'),
    E('e6', 'bRound', 'true', 'wRound', 'exec'),
    E('e7', 'bRound', 'false', 'bEntry', 'exec'),
    E('e8', 'mEntry', 'matched', 'bEntry', 'condition'),
    E('e9', 'bEntry', 'true', 'wEntry', 'exec'),
    E('e10', 'bEntry', 'false', 'wRaw', 'exec'),
    E('e11', 'onlog', 'line', 'mSess', 'text'),
    E('e12', 'onlog', 'line', 'mRound', 'text'),
    E('e13', 'onlog', 'line', 'mEntry', 'text'),
    E('e14', 'mSess', 'g1', 'wSess', 'label'),
    E('e15', 'mRound', 'g1', 'fmtRound', 'a1'),
    E('e16', 'fmtRound', 'out', 'wRound', 'label'),
    E('e17', 'onlog', 'ts', 'wEntry', 'time'),
    E('e18', 'mEntry', 'g1', 'wEntry', 'tag'),
    E('e19', 'tc', 'color', 'wEntry', 'color'),
    E('e20', 'mEntry', 'g3', 'wEntry', 'mergeKey'),
    E('e21', 'mEntry', 'g1', 'tc', 'tag'),
    E('e22', 'mEntry', 'g1', 'fmtEntry', 'a1'),
    E('e23', 'mEntry', 'g2', 'fmtEntry', 'a2'),
    E('e24', 'mEntry', 'g3', 'fmtEntry', 'a3'),
    E('e25', 'fmtEntry', 'out', 'wEntry', 'text'),
    E('e26', 'onlog', 'ts', 'wRaw', 'time'),
    E('e27', 'onlog', 'line', 'wRaw', 'text'),
  ]
  return { nodes, edges }
}

function reportGraph(): SerializedGraph {
  const nodes = [
    N('start', 'event/onStart', 0, 0),
    N('fetch', 'report/fetchRds', 300, 0, { dateRange: '昨天' }),
    N(
      'fill',
      'report/fillTemplate',
      300, 260,
      {
        template:
          '## Dolphin 错误报表（{{dateRange}}）\n\n' +
          '- 崩溃率（Crash-Free）：**{{crashFreeRate}}**\n' +
          '- 影响会话数：{{affectedSessions}}\n' +
          '- 上报总事件数：{{totalEvents}}\n\n' +
          '### Top 错误\n\n' +
          '| 错误 | 次数 | 占比 | 最近发生 |\n' +
          '|---|---|---|---|\n' +
          '{{#each topErrors}}| {{name}} | {{count}} | {{rate}} | {{lastSeen}} |\n' +
          '{{/each}}\n' +
          '> 由 Blueprint Studio 报表插件自动生成',
      },
    ),
    N('md', 'output/markdown', 620, 0, { title: '错误报表' }),
    N('push', 'report/pushFeishu', 940, 0, { docTitle: 'Dolphin 错误报表' }),
    N('pr', 'action/print', 1240, 0),
  ]
  const edges = [
    E('e1', 'start', 'exec', 'fetch', 'exec'),
    E('e2', 'fetch', 'stats', 'fill', 'json'),
    E('e3', 'fetch', 'exec', 'md', 'exec'),
    E('e4', 'fill', 'md', 'md', 'content'),
    E('e5', 'md', 'exec', 'push', 'exec'),
    E('e6', 'fill', 'md', 'push', 'md'),
    E('e7', 'push', 'exec', 'pr', 'exec'),
    E('e8', 'push', 'detail', 'pr', 'message'),
  ]
  return { nodes, edges }
}

export function buildPlugin(
  id: string,
  middlewareId: string,
  name: string,
  templateId: TemplateId,
): PluginRecord {
  let graph: SerializedGraph
  let vars: VariableDef[]
  switch (templateId) {
    case 'logviewer':
      graph = logViewerGraph()
      vars = [{ name: 'packageName', type: 'string', default: 'com.dolphin.game' }]
      break
    case 'report':
      graph = reportGraph()
      vars = []
      break
    default:
      graph = { nodes: [N('start', 'event/onStart', 80, 120)], edges: [] }
      vars = []
  }
  return { id, middlewareId, name, graph, vars, updatedAt: Date.now() }
}
