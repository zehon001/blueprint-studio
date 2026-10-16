import type {
  PluginRecord,
  SerializedGraph,
  SubgraphDef,
  UIComponent,
  VariableDef,
} from './types'

/**
 * 插件模板 —— 类似 UE5 的新建项目模板。
 * 生成即带完整可运行的蓝图、UI 界面（类 UGUI 预制体）与子蓝图。
 */

export type TemplateId = 'logviewer' | 'report' | 'blank'

export const TEMPLATES: { id: TemplateId; name: string; description: string }[] = [
  {
    id: 'logviewer',
    name: '日志查看器',
    description: '自定义 UI（包名输入/设备选择/列表列），子蓝图解析日志，流式输出',
  },
  {
    id: 'report',
    name: '报表输出',
    description: 'RDS 数据填模板渲染 Markdown，可推送飞书，UI 上带刷新按钮',
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

function U(
  id: string,
  kind: UIComponent['kind'],
  props: Record<string, unknown>,
  children?: UIComponent[],
): UIComponent {
  return { id, kind, props, children }
}

// ────────── 日志查看器 ──────────

function logViewerUi(): UIComponent {
  return U('ui-root', 'vbox', { gap: 10 }, [
    U('comp-connect-panel', 'panel', { title: '连接' }, [
      U('comp-connect-row', 'hbox', { gap: 8 }, [
        U('comp-pkg', 'input', { label: '包名', placeholder: 'com.dolphin.game', grow: 1 }),
        U('comp-device', 'select', {
          label: '设备',
          options: '模拟设备 A\n模拟设备 B',
        }),
        U('comp-connect', 'button', { text: '连接' }),
        U('comp-status', 'text', { text: '未连接', grow: 2 }),
      ]),
    ]),
    U('comp-log-panel', 'panel', { title: '日志', grow: 1 }, [
      U('comp-log', 'list', {
        autoScroll: true,
        columns: [
          { key: 'time', label: '时间' },
          {
            key: 'kind',
            label: '类型',
            colorMap:
              'INFO=#3fc1a9\n会话=#9fc3e8\n轮次=#8ad4a0\nWARN=#d9a441\nERROR=#e06c75\nDEBUG=#8a94a8\n其他=#8b90a0',
          },
          { key: 'message', label: '内容', merge: true },
          { key: 'round', label: '轮次' },
          { key: 'session', label: '会话', group: true },
        ],
      }),
    ]),
  ])
}

function parseLogSubgraph(): SubgraphDef {
  const nodes = [
    N('sin', 'sub/input', 0, 0),
    N('mSess', 'transform/regexMatch', 240, 60, { pattern: '=== SESSION START (.+) ===' }),
    N('bSess', 'logic/branch', 520, 0),
    N('kSess', 'data/literal-string', 240, 200, { value: '会话' }),
    N('tjSess', 'transform/toJson', 700, 120, { keys: 'time,kind,message,session,round' }),
    N('outSess', 'sub/output', 960, 40),
    N('mRound', 'transform/regexMatch', 240, 400, { pattern: '--- ROUND (\\d+) ---' }),
    N('bRound', 'logic/branch', 520, 280),
    N('kRound', 'data/literal-string', 240, 540, { value: '轮次' }),
    N('fmtRound', 'transform/formatText', 460, 620, { template: '第 {1} 轮' }),
    N('tjRound', 'transform/toJson', 700, 440, { keys: 'time,kind,message,session,round' }),
    N('outRound', 'sub/output', 960, 260),
    N('mEntry', 'transform/regexMatch', 240, 780, { pattern: '\\[(\\w+)\\] ([\\w.]+): (.*)' }),
    N('bEntry', 'logic/branch', 520, 680),
    N('fmtEntry', 'transform/formatText', 460, 980, { template: '{2}：{3}' }),
    N('tjEntry', 'transform/toJson', 700, 800, { keys: 'time,kind,message,session,round' }),
    N('outEntry', 'sub/output', 960, 640),
    N('kOther', 'data/literal-string', 240, 1120, { value: '其他' }),
    N('tjOther', 'transform/toJson', 700, 1020, { keys: 'time,kind,message' }),
    N('outOther', 'sub/output', 960, 900),
  ]
  const edges = [
    E('s1', 'sin', 'exec', 'bSess', 'exec'),
    E('s2', 'sin', 'line', 'mSess', 'text'),
    E('s3', 'mSess', 'matched', 'bSess', 'condition'),
    E('s4', 'bSess', 'true', 'outSess', 'exec'),
    E('s5', 'sin', 'ts', 'tjSess', 'a1'),
    E('s6', 'kSess', 'value', 'tjSess', 'a2'),
    E('s7', 'sin', 'line', 'tjSess', 'a3'),
    E('s8', 'mSess', 'g1', 'tjSess', 'a4'),
    E('s9', 'tjSess', 'json', 'outSess', 'row'),
    E('s10', 'bSess', 'false', 'bRound', 'exec'),
    E('s11', 'sin', 'line', 'mRound', 'text'),
    E('s12', 'mRound', 'matched', 'bRound', 'condition'),
    E('s13', 'bRound', 'true', 'outRound', 'exec'),
    E('s14', 'sin', 'ts', 'tjRound', 'a1'),
    E('s15', 'kRound', 'value', 'tjRound', 'a2'),
    E('s16', 'fmtRound', 'out', 'tjRound', 'a3'),
    E('s17', 'mRound', 'g1', 'fmtRound', 'a1'),
    E('s18', 'mRound', 'g1', 'tjRound', 'a5'),
    E('s19', 'tjRound', 'json', 'outRound', 'row'),
    E('s20', 'bRound', 'false', 'bEntry', 'exec'),
    E('s21', 'sin', 'line', 'mEntry', 'text'),
    E('s22', 'mEntry', 'matched', 'bEntry', 'condition'),
    E('s23', 'bEntry', 'true', 'outEntry', 'exec'),
    E('s25', 'sin', 'ts', 'tjEntry', 'a1'),
    E('s26', 'mEntry', 'g1', 'tjEntry', 'a2'),
    E('s27', 'fmtEntry', 'out', 'tjEntry', 'a3'),
    E('s28', 'mEntry', 'g2', 'fmtEntry', 'a2'),
    E('s29', 'mEntry', 'g3', 'fmtEntry', 'a3'),
    E('s30', 'tjEntry', 'json', 'outEntry', 'row'),
    E('s31', 'bEntry', 'false', 'outOther', 'exec'),
    E('s33', 'sin', 'ts', 'tjOther', 'a1'),
    E('s34', 'kOther', 'value', 'tjOther', 'a2'),
    E('s35', 'sin', 'line', 'tjOther', 'a3'),
    E('s36', 'tjOther', 'json', 'outOther', 'row'),
  ]
  return {
    id: 'parse',
    name: '解析日志行',
    params: [
      { name: 'line', type: 'string' },
      { name: 'ts', type: 'string' },
    ],
    returns: [{ name: 'row', type: 'string' }],
    graph: { nodes, edges },
  }
}

function logViewerGraph(): SerializedGraph {
  const nodes = [
    N('start', 'event/onStart', 0, 0),
    N('pr1', 'action/print', 260, 0),
    N('lit1', 'data/literal-string', 0, 160, { value: '引擎启动，演示日志流入中…' }),
    N('srcDemo', 'source/demo', 0, 340, { preset: 'dolphin', rate: 3 }),
    N('onlog', 'event/onLogLine', 300, 300, { source: 'srcDemo' }),
    N('parse', 'sub/parse', 600, 300),
    N('listAdd', 'ui/listAdd', 880, 300, { component: 'comp-log' }),
    N('devChange', 'event/uiChange', 300, 620, { component: 'comp-device' }),
    N('fmtDev', 'transform/formatText', 560, 620, { template: '设备：{1}' }),
    N('setStatus', 'ui/set', 820, 620, { component: 'comp-status' }),
    N('connClick', 'event/uiClick', 300, 860, { component: 'comp-connect' }),
    N('getPkg', 'ui/get', 500, 1000, { component: 'comp-pkg' }),
    N('fmtConn', 'transform/formatText', 560, 860, { template: '连接 {1} ✓' }),
    N('prConn', 'action/print', 840, 860),
  ]
  const edges = [
    E('e1', 'start', 'exec', 'pr1', 'exec'),
    E('e2', 'lit1', 'value', 'pr1', 'message'),
    E('e3', 'onlog', 'exec', 'parse', 'exec'),
    E('e4', 'onlog', 'line', 'parse', 'line'),
    E('e5', 'onlog', 'ts', 'parse', 'ts'),
    E('e6', 'parse', 'exec', 'listAdd', 'exec'),
    E('e7', 'parse', 'row', 'listAdd', 'row'),
    E('e8', 'devChange', 'exec', 'setStatus', 'exec'),
    E('e9', 'devChange', 'value', 'fmtDev', 'a1'),
    E('e11', 'fmtDev', 'out', 'setStatus', 'value'),
    E('e12', 'connClick', 'exec', 'prConn', 'exec'),
    E('e13', 'getPkg', 'value', 'fmtConn', 'a1'),
    E('e15', 'fmtConn', 'out', 'prConn', 'message'),
  ]
  return { nodes, edges }
}

// ────────── 错误报表 ──────────

function reportUi(): UIComponent {
  return U('ui-root', 'vbox', { gap: 10 }, [
    U('comp-report-panel', 'panel', { title: '错误报表' }, [
      U('comp-report-row', 'hbox', { gap: 8 }, [
        U('comp-refresh', 'button', { text: '↻ 刷新' }),
        U('comp-hint', 'text', { text: '从 RDS 拉取统计数据并填充模板', grow: 1 }),
      ]),
      U('comp-report', 'markdown', { text: '（等待内容…）', grow: 1 }),
    ]),
  ])
}

const REPORT_TEMPLATE =
  '## Dolphin 错误报表（{{dateRange}}）\n\n' +
  '- 崩溃率（Crash-Free）：**{{crashFreeRate}}**\n' +
  '- 影响会话数：{{affectedSessions}}\n' +
  '- 上报总事件数：{{totalEvents}}\n\n' +
  '### Top 错误\n\n' +
  '| 错误 | 次数 | 占比 | 最近发生 |\n' +
  '|---|---|---|---|\n' +
  '{{#each topErrors}}| {{name}} | {{count}} | {{rate}} | {{lastSeen}} |\n' +
  '{{/each}}\n' +
  '> 由 Blueprint Studio 报表插件自动生成'

function reportChain(prefix: string, x: number): { nodes: SerializedGraph['nodes']; edges: SerializedGraph['edges'] } {
  const nodes = [
    N(`${prefix}fetch`, 'report/fetchRds', x, 0, { dateRange: '昨天' }),
    N(`${prefix}fill`, 'report/fillTemplate', x + 60, 260, { template: REPORT_TEMPLATE }),
    N(`${prefix}md`, 'ui/set', x + 360, 0, { component: 'comp-report' }),
    N(`${prefix}push`, 'report/pushFeishu', x + 640, 0, { docTitle: 'Dolphin 错误报表' }),
    N(`${prefix}pr`, 'action/print', x + 940, 0),
  ]
  const edges = [
    E(`${prefix}e1`, `${prefix}fetch`, 'exec', `${prefix}md`, 'exec'),
    E(`${prefix}e2`, `${prefix}fetch`, 'stats', `${prefix}fill`, 'json'),
    E(`${prefix}e3`, `${prefix}fill`, 'md', `${prefix}md`, 'value'),
    E(`${prefix}e4`, `${prefix}md`, 'exec', `${prefix}push`, 'exec'),
    E(`${prefix}e5`, `${prefix}fill`, 'md', `${prefix}push`, 'md'),
    E(`${prefix}e6`, `${prefix}push`, 'exec', `${prefix}pr`, 'exec'),
    E(`${prefix}e7`, `${prefix}push`, 'detail', `${prefix}pr`, 'message'),
  ]
  return { nodes, edges }
}

function reportGraph(): SerializedGraph {
  const start = [N('start', 'event/onStart', 0, 0)]
  const refresh = [N('refresh', 'event/uiClick', 0, 300, { component: 'comp-refresh' })]
  const c1 = reportChain('a', 300)
  const c2 = reportChain('b', 300)
  return {
    nodes: [...start, ...refresh, ...c1.nodes, ...c2.nodes],
    edges: [
      E('r1', 'start', 'exec', 'afetch', 'exec'),
      E('r2', 'refresh', 'exec', 'bfetch', 'exec'),
      ...c1.edges,
      ...c2.edges,
    ],
  }
}

// ────────── 装配 ──────────

export function buildPlugin(
  id: string,
  middlewareId: string,
  name: string,
  templateId: TemplateId,
): PluginRecord {
  let graph: SerializedGraph
  let subgraphs: SubgraphDef[]
  let ui: UIComponent
  let vars: VariableDef[]
  switch (templateId) {
    case 'logviewer':
      graph = logViewerGraph()
      subgraphs = [parseLogSubgraph()]
      ui = logViewerUi()
      vars = [{ name: 'packageName', type: 'string', default: 'com.dolphin.game' }]
      break
    case 'report':
      graph = reportGraph()
      subgraphs = []
      ui = reportUi()
      vars = []
      break
    default:
      graph = { nodes: [N('start', 'event/onStart', 80, 120)], edges: [] }
      subgraphs = []
      ui = U('ui-root', 'vbox', { gap: 10 }, [
        U('comp-hello', 'text', { text: 'Hello，从左侧节点库开始搭建蓝图吧' }),
      ])
      vars = []
  }
  return { id, middlewareId, name, graph, subgraphs, ui, vars, updatedAt: Date.now() }
}
