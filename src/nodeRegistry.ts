import { widgetIdOf, type NodeDef } from './types'

const str = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : String(v))
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}
const parseMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const line of str(v).split('\n')) {
    const idx = line.indexOf('=')
    if (idx > 0) out[line.slice(0, idx).trim().toUpperCase()] = line.slice(idx + 1).trim()
  }
  return out
}
function widgetFx(
  kind: 'logTree' | 'markdown' | 'flow',
  title: unknown,
  op: string,
  payload: Record<string, unknown>,
) {
  return {
    kind: 'widget' as const,
    widgetId: widgetIdOf(kind, title),
    op,
    payload,
  }
}

/**
 * 声明式节点注册表——平台唯一的节点目录。
 * 一份定义同时驱动：节点库面板、节点/端口渲染、连线类型校验、脚本互转、执行引擎。
 * 输出类节点通过 fx(widget) 更新运行时小组件；需要后端能力的节点走 ctx.rpc。
 */
export const registry: NodeDef[] = [
  // ── 事件 ──
  {
    id: 'event/onStart',
    alias: '事件.开始',
    title: '开始',
    category: 'event',
    description: '插件运行时最先触发一次（类似蓝图的 BeginPlay）',
    inputs: [],
    outputs: [{ id: 'exec', label: '', type: 'exec' }],
    run: () => ({ exec: 'exec' }),
  },
  {
    id: 'event/onLogLine',
    alias: '事件.日志行',
    title: '日志行',
    category: 'event',
    description: '收到所选日志源推送的一行日志时触发（流式，持续输出）',
    inputs: [],
    outputs: [
      { id: 'exec', label: '', type: 'exec' },
      { id: 'line', label: '日志行', type: 'any' },
      { id: 'ts', label: '时间', type: 'any' },
    ],
    params: [{ key: 'source', label: '日志源', valueType: 'source' }],
    run: (_i, ctx) => ({
      exec: 'exec',
      outputs: { line: ctx.event?.line, ts: ctx.event?.ts },
    }),
  },
  {
    id: 'event/onTick',
    alias: '事件.定时',
    title: '定时',
    category: 'event',
    description: '按间隔重复触发，适合刷新报表等轮转任务',
    inputs: [],
    outputs: [
      { id: 'exec', label: '', type: 'exec' },
      { id: 'count', label: '次数', type: 'number' },
    ],
    params: [{ key: 'intervalMs', label: '间隔(ms)', valueType: 'number', default: 1000 }],
    run: (_i, ctx) => {
      ctx.state.count = num(ctx.state.count) + 1
      return { exec: 'exec', outputs: { count: ctx.state.count } }
    },
  },

  // ── 源（声明型节点：运行时由后端适配器供数） ──
  {
    id: 'source/demo',
    alias: '源.演示日志',
    title: '演示日志',
    category: 'source',
    description: '后端生成模拟日志（含会话/轮次/高频重复行），用于体验与调试',
    inputs: [],
    outputs: [],
    params: [
      {
        key: 'preset',
        label: '预设',
        valueType: 'select',
        default: 'dolphin',
        options: [{ value: 'dolphin', label: 'Dolphin 轮唱日志' }],
      },
      { key: 'rate', label: '速度(行/秒)', valueType: 'number', default: 3 },
    ],
    run: () => ({}),
  },
  {
    id: 'source/adb',
    alias: '源.手机日志',
    title: '手机日志',
    category: 'source',
    description: '通过后端 adb logcat 读取真机日志（需要设备连接）',
    inputs: [],
    outputs: [],
    params: [
      { key: 'package', label: '包名(变量)', valueType: 'variable', variableType: 'string' },
      { key: 'tag', label: '过滤标签', valueType: 'string', default: '' },
    ],
    run: () => ({}),
  },
  {
    id: 'source/file',
    alias: '源.日志文件',
    title: '日志文件',
    category: 'source',
    description: '读取上传到资产库的日志文件，逐行输出并持续监听追加',
    inputs: [],
    outputs: [],
    params: [
      { key: 'asset', label: '日志文件', valueType: 'asset' },
      { key: 'intervalMs', label: '行间隔(ms)', valueType: 'number', default: 120 },
    ],
    run: () => ({}),
  },

  // ── 逻辑 ──
  {
    id: 'logic/branch',
    alias: '逻辑.条件分支',
    title: '条件分支',
    category: 'logic',
    description: '按布尔值选择「真」或「假」路径（未连接时视为假）',
    inputs: [
      { id: 'exec', label: '', type: 'exec' },
      { id: 'condition', label: '条件', type: 'boolean' },
    ],
    outputs: [
      { id: 'true', label: '真', type: 'exec' },
      { id: 'false', label: '假', type: 'exec' },
    ],
    run: (i) => ({ exec: i.condition ? 'true' : 'false' }),
  },
  {
    id: 'logic/delay',
    alias: '逻辑.延时',
    title: '延时',
    category: 'logic',
    description: '等待若干毫秒后继续（潜藏节点，异步执行）',
    inputs: [{ id: 'exec', label: '', type: 'exec' }],
    outputs: [{ id: 'exec', label: '', type: 'exec' }],
    params: [{ key: 'ms', label: '毫秒', valueType: 'number', default: 500 }],
    run: async (_i, ctx) => {
      await new Promise((r) => setTimeout(r, num(ctx.params.ms) || 500))
      return { exec: 'exec' }
    },
  },
  {
    id: 'logic/and',
    alias: '逻辑.与',
    title: '与',
    category: 'logic',
    pure: true,
    description: '两个布尔值都为真时输出真',
    inputs: [
      { id: 'a', label: 'A', type: 'boolean' },
      { id: 'b', label: 'B', type: 'boolean' },
    ],
    outputs: [{ id: 'value', label: '结果', type: 'boolean' }],
    run: (i) => ({ outputs: { value: Boolean(i.a) && Boolean(i.b) } }),
  },

  // ── 处理 ──
  {
    id: 'transform/regexMatch',
    alias: '处理.正则匹配',
    title: '正则匹配',
    category: 'transform',
    pure: true,
    description: '对文本执行正则，输出是否匹配与捕获组 g1~g3',
    inputs: [{ id: 'text', label: '文本', type: 'string' }],
    outputs: [
      { id: 'matched', label: '匹配', type: 'boolean' },
      { id: 'g1', label: '组1', type: 'any' },
      { id: 'g2', label: '组2', type: 'any' },
      { id: 'g3', label: '组3', type: 'any' },
    ],
    params: [{ key: 'pattern', label: '正则', valueType: 'text', default: '(.*)' }],
    run: (i, ctx) => {
      const m = str(i.text).match(str(ctx.params.pattern) || '(.*)')
      if (!m) return { outputs: { matched: false, g1: undefined, g2: undefined, g3: undefined } }
      return { outputs: { matched: true, g1: m[1], g2: m[2], g3: m[3] } }
    },
  },
  {
    id: 'transform/formatText',
    alias: '处理.格式化',
    title: '格式化',
    category: 'transform',
    pure: true,
    description: '用 {1} {2} {3} 占位符拼接文本',
    inputs: [
      { id: 'a1', label: '值1', type: 'any' },
      { id: 'a2', label: '值2', type: 'any' },
      { id: 'a3', label: '值3', type: 'any' },
    ],
    outputs: [{ id: 'out', label: '结果', type: 'string' }],
    params: [{ key: 'template', label: '模板', valueType: 'string', default: '{1} {2} {3}' }],
    run: (_i, ctx) => ({
      outputs: {
        out: str(ctx.params.template)
          .replaceAll('{1}', str(_i.a1))
          .replaceAll('{2}', str(_i.a2))
          .replaceAll('{3}', str(_i.a3)),
      },
    }),
  },
  {
    id: 'transform/tagColor',
    alias: '处理.标签配色',
    title: '标签配色',
    category: 'transform',
    pure: true,
    description: '把日志级别映射为颜色（每行 KEY=颜色，如 INFO=#3fc1a9）',
    inputs: [{ id: 'tag', label: '标签', type: 'string' }],
    outputs: [
      { id: 'color', label: '颜色', type: 'string' },
      { id: 'name', label: '名称', type: 'string' },
    ],
    params: [
      {
        key: 'map',
        label: '映射',
        valueType: 'map',
        default: 'INFO=#3fc1a9\nWARN=#d9a441\nERROR=#e06c75\nDEBUG=#8a94a8',
      },
    ],
    run: (i, ctx) => {
      const map = parseMap(ctx.params.map)
      const tag = str(i.tag).toUpperCase()
      return { outputs: { color: map[tag] ?? '#8b90a0', name: tag } }
    },
  },
  {
    id: 'transform/toNumber',
    alias: '处理.转数字',
    title: '转数字',
    category: 'transform',
    pure: true,
    description: '把任意值解析为数字（失败为 0）',
    inputs: [{ id: 'text', label: '值', type: 'any' }],
    outputs: [{ id: 'value', label: '数字', type: 'number' }],
    run: (i) => ({ outputs: { value: num(i.text) } }),
  },

  // ── 变量 ──
  {
    id: 'var/get',
    alias: '变量.读取',
    title: '读取变量',
    category: 'variable',
    pure: true,
    description: '读取蓝图变量的当前值',
    inputs: [],
    outputs: [{ id: 'value', label: '值', type: 'any' }],
    params: [{ key: 'name', label: '变量', valueType: 'variable' }],
    run: (_i, ctx) => ({ outputs: { value: ctx.vars[str(ctx.params.name)] } }),
  },
  {
    id: 'var/set',
    alias: '变量.写入',
    title: '写入变量',
    category: 'variable',
    description: '写入蓝图变量（影响后续读取）',
    inputs: [
      { id: 'exec', label: '', type: 'exec' },
      { id: 'value', label: '值', type: 'any' },
    ],
    outputs: [{ id: 'exec', label: '', type: 'exec' }],
    params: [{ key: 'name', label: '变量', valueType: 'variable' }],
    run: (i, ctx) => {
      ctx.vars[str(ctx.params.name)] = i.value
      return { exec: 'exec' }
    },
  },

  // ── 资产 ──
  {
    id: 'asset/list',
    alias: '资产.清单',
    title: '资产清单',
    category: 'asset',
    pure: true,
    description: '后端资产库的清单（JSON 字符串）',
    inputs: [],
    outputs: [{ id: 'json', label: 'JSON', type: 'string' }],
    run: (_i, ctx) => ({ outputs: { json: JSON.stringify(ctx.assets) } }),
  },
  {
    id: 'asset/url',
    alias: '资产.地址',
    title: '资产地址',
    category: 'asset',
    pure: true,
    description: '按名称取资产的后端访问地址',
    inputs: [{ id: 'name', label: '名称', type: 'string' }],
    outputs: [{ id: 'url', label: '地址', type: 'string' }],
    run: (i) => ({ outputs: { url: `/assets/uploads/${str(i.name)}` } }),
  },

  // ── 报表 ──
  {
    id: 'report/fetchRds',
    alias: '报表.取数据',
    title: '取报表数据',
    category: 'report',
    description: '从 RDS 埋点平台拉取统计数据（后端 RPC）',
    inputs: [{ id: 'exec', label: '', type: 'exec' }],
    outputs: [
      { id: 'exec', label: '', type: 'exec' },
      { id: 'stats', label: 'JSON', type: 'string' },
    ],
    params: [{ key: 'dateRange', label: '时间范围', valueType: 'string', default: '昨天' }],
    run: async (_i, ctx) => {
      const stats = await ctx.rpc('report.getStats', {
        dateRange: str(ctx.params.dateRange) || '昨天',
      })
      return { exec: 'exec', outputs: { stats: JSON.stringify(stats) } }
    },
  },
  {
    id: 'report/fillTemplate',
    alias: '报表.填模板',
    title: '填报表模板',
    category: 'report',
    pure: true,
    description: '把 JSON 数据填入 Markdown 模板（{{key}} 与 {{#each 列表}}）',
    inputs: [{ id: 'json', label: 'JSON', type: 'string' }],
    outputs: [{ id: 'md', label: 'MD', type: 'string' }],
    params: [
      {
        key: 'template',
        label: '模板',
        valueType: 'text',
        default: '## 报表（{{dateRange}}）\n\n- 崩溃率：{{crashFreeRate}}\n\n| 错误 | 次数 |\n|---|---|\n{{#each topErrors}}| {{name}} | {{count}} |\n{{/each}}',
      },
    ],
    run: (i, ctx) => {
      let data: Record<string, unknown> = {}
      try {
        data = JSON.parse(str(i.json) || '{}')
      } catch {
        data = {}
      }
      const md = str(ctx.params.template)
        .replace(/\{\{#each (\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_m, key: string, body: string) => {
          const rows = data[key]
          return Array.isArray(rows)
            ? rows
                .map((row) =>
                  body.replace(/\{\{(\w+)\}\}/g, (_2, k: string) => str((row as any)[k])),
                )
                .join('')
            : ''
        })
        .replace(/\{\{(\w+)\}\}/g, (_m, k: string) => str(data[k]))
      return { outputs: { md } }
    },
  },
  {
    id: 'report/pushFeishu',
    alias: '报表.推送飞书',
    title: '推送飞书',
    category: 'report',
    description: '把 Markdown 报表推送到飞书文档（后端 RPC，需配置 webhook）',
    inputs: [
      { id: 'exec', label: '', type: 'exec' },
      { id: 'md', label: 'MD', type: 'string' },
    ],
    outputs: [
      { id: 'exec', label: '', type: 'exec' },
      { id: 'ok', label: '成功', type: 'boolean' },
      { id: 'detail', label: '详情', type: 'string' },
    ],
    params: [{ key: 'docTitle', label: '文档标题', valueType: 'string', default: '错误报表' }],
    run: async (i, ctx) => {
      const res = (await ctx.rpc('feishu.pushDoc', {
        title: str(ctx.params.docTitle) || '错误报表',
        md: str(i.md),
      })) as { ok?: boolean; detail?: string } | null
      return {
        exec: 'exec',
        outputs: { ok: Boolean(res?.ok), detail: str(res?.detail) },
      }
    },
  },

  // ── 输出（运行时小组件） ──
  {
    id: 'output/logTreeSession',
    alias: '输出.日志树会话',
    title: '树·新会话',
    category: 'output',
    widgetKind: 'logTree',
    description: '在日志树小组件中开一个会话分组（session）',
    inputs: [
      { id: 'exec', label: '', type: 'exec' },
      { id: 'label', label: '标题', type: 'string' },
    ],
    outputs: [{ id: 'exec', label: '', type: 'exec' }],
    params: [{ key: 'title', label: '小组件', valueType: 'string', default: '运行日志' }],
    run: (i, ctx) => ({
      exec: 'exec',
      fx: [widgetFx('logTree', ctx.params.title, 'session', { label: str(i.label) })],
    }),
  },
  {
    id: 'output/logTreeRound',
    alias: '输出.日志树轮次',
    title: '树·新轮次',
    category: 'output',
    widgetKind: 'logTree',
    description: '在当前会话下开一个轮次分组（round）',
    inputs: [
      { id: 'exec', label: '', type: 'exec' },
      { id: 'label', label: '标题', type: 'string' },
    ],
    outputs: [{ id: 'exec', label: '', type: 'exec' }],
    params: [{ key: 'title', label: '小组件', valueType: 'string', default: '运行日志' }],
    run: (i, ctx) => ({
      exec: 'exec',
      fx: [widgetFx('logTree', ctx.params.title, 'round', { label: str(i.label) })],
    }),
  },
  {
    id: 'output/logTreeEntry',
    alias: '输出.日志树条目',
    title: '树·条目',
    category: 'output',
    widgetKind: 'logTree',
    description:
      '向日志树追加一条日志条目：时间/文本/标签/颜色；相同合并键的高频日志会折叠成一条并计数',
    inputs: [
      { id: 'exec', label: '', type: 'exec' },
      { id: 'time', label: '时间', type: 'string' },
      { id: 'text', label: '文本', type: 'string' },
      { id: 'tag', label: '标签', type: 'string' },
      { id: 'color', label: '颜色', type: 'string' },
      { id: 'mergeKey', label: '合并键', type: 'string' },
    ],
    outputs: [{ id: 'exec', label: '', type: 'exec' }],
    params: [{ key: 'title', label: '小组件', valueType: 'string', default: '运行日志' }],
    run: (i, ctx) => ({
      exec: 'exec',
      fx: [
        widgetFx('logTree', ctx.params.title, 'entry', {
          time: str(i.time),
          text: str(i.text),
          tag: str(i.tag),
          color: str(i.color),
          mergeKey: str(i.mergeKey),
        }),
      ],
    }),
  },
  {
    id: 'output/markdown',
    alias: '输出.文档',
    title: 'Markdown',
    category: 'output',
    widgetKind: 'markdown',
    description: '渲染 Markdown 内容的小组件（报表等）',
    inputs: [
      { id: 'exec', label: '', type: 'exec' },
      { id: 'content', label: '内容', type: 'string' },
    ],
    outputs: [{ id: 'exec', label: '', type: 'exec' }],
    params: [{ key: 'title', label: '标题', valueType: 'string', default: '文档' }],
    run: (i, ctx) => ({
      exec: 'exec',
      fx: [widgetFx('markdown', ctx.params.title, 'set', { content: str(i.content) })],
    }),
  },
  {
    id: 'output/flowAddNode',
    alias: '输出.流程加节点',
    title: '流程·加节点',
    category: 'output',
    widgetKind: 'flow',
    description: '向流程图小组件添加一个节点',
    inputs: [
      { id: 'exec', label: '', type: 'exec' },
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'label', label: '标签', type: 'string' },
    ],
    outputs: [{ id: 'exec', label: '', type: 'exec' }],
    params: [{ key: 'title', label: '小组件', valueType: 'string', default: '流程' }],
    run: (i, ctx) => ({
      exec: 'exec',
      fx: [
        widgetFx('flow', ctx.params.title, 'addNode', { id: str(i.id), label: str(i.label) }),
      ],
    }),
  },
  {
    id: 'output/flowAddEdge',
    alias: '输出.流程加连线',
    title: '流程·加连线',
    category: 'output',
    widgetKind: 'flow',
    description: '向流程图小组件连接两个节点',
    inputs: [
      { id: 'exec', label: '', type: 'exec' },
      { id: 'from', label: '起点', type: 'string' },
      { id: 'to', label: '终点', type: 'string' },
    ],
    outputs: [{ id: 'exec', label: '', type: 'exec' }],
    params: [{ key: 'title', label: '小组件', valueType: 'string', default: '流程' }],
    run: (i, ctx) => ({
      exec: 'exec',
      fx: [widgetFx('flow', ctx.params.title, 'addEdge', { from: str(i.from), to: str(i.to) })],
    }),
  },
  {
    id: 'output/flowActive',
    alias: '输出.流程激活',
    title: '流程·激活',
    category: 'output',
    widgetKind: 'flow',
    description: '点亮流程图小组件中当前活跃的节点',
    inputs: [
      { id: 'exec', label: '', type: 'exec' },
      { id: 'id', label: 'ID', type: 'string' },
    ],
    outputs: [{ id: 'exec', label: '', type: 'exec' }],
    params: [{ key: 'title', label: '小组件', valueType: 'string', default: '流程' }],
    run: (i, ctx) => ({
      exec: 'exec',
      fx: [widgetFx('flow', ctx.params.title, 'setActive', { id: str(i.id) })],
    }),
  },

  // ── 动作 ──
  {
    id: 'action/print',
    alias: '动作.打印',
    title: '打印',
    category: 'action',
    description: '向控制台输出一条消息',
    inputs: [
      { id: 'exec', label: '', type: 'exec' },
      { id: 'message', label: '消息', type: 'string' },
    ],
    outputs: [{ id: 'exec', label: '', type: 'exec' }],
    run: (i) => ({ exec: 'exec', fx: [{ kind: 'print', value: str(i.message) }] }),
  },

  // ── 数据（纯节点） ──
  {
    id: 'math/add',
    alias: '数据.相加',
    title: '相加',
    category: 'data',
    pure: true,
    description: '两个数字相加',
    inputs: [
      { id: 'a', label: 'A', type: 'number' },
      { id: 'b', label: 'B', type: 'number' },
    ],
    outputs: [{ id: 'result', label: '结果', type: 'number' }],
    run: (i) => ({ outputs: { result: num(i.a) + num(i.b) } }),
  },
  {
    id: 'data/literal-string',
    alias: '数据.文本常量',
    title: '文本常量',
    category: 'data',
    pure: true,
    description: '字符串常量，可直接在节点上编辑',
    inputs: [],
    outputs: [{ id: 'value', label: '值', type: 'string' }],
    params: [{ key: 'value', label: '文本', valueType: 'string', default: '文本' }],
    run: (_i, ctx) => ({ outputs: { value: str(ctx.params.value) } }),
  },
  {
    id: 'data/literal-number',
    alias: '数据.数字常量',
    title: '数字常量',
    category: 'data',
    pure: true,
    description: '数字常量，可直接在节点上编辑',
    inputs: [],
    outputs: [{ id: 'value', label: '值', type: 'number' }],
    params: [{ key: 'value', label: '数值', valueType: 'number', default: 0 }],
    run: (_i, ctx) => ({ outputs: { value: num(ctx.params.value) } }),
  },
  {
    id: 'data/literal-boolean',
    alias: '数据.布尔常量',
    title: '布尔常量',
    category: 'data',
    pure: true,
    description: '布尔常量，可直接在节点上勾选',
    inputs: [],
    outputs: [{ id: 'value', label: '值', type: 'boolean' }],
    params: [{ key: 'value', label: '值', valueType: 'boolean', default: false }],
    run: (_i, ctx) => ({ outputs: { value: Boolean(ctx.params.value) } }),
  },
]

export const registryById: Record<string, NodeDef> = Object.fromEntries(
  registry.map((n) => [n.id, n]),
)

export const registryByAlias: Record<string, NodeDef> = Object.fromEntries(
  registry.map((n) => [n.alias, n]),
)
