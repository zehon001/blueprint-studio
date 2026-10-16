import type { NodeDef } from './types'

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
function uiFx(compId: unknown, op: 'set' | 'listAdd' | 'clear', payload: { value?: unknown; row?: unknown }) {
  return { kind: 'ui' as const, compId: str(compId), op, ...payload }
}

/**
 * 声明式节点注册表——平台唯一的节点目录。
 * 一份定义同时驱动：节点库面板、节点/端口渲染、连线类型校验、脚本互转、执行引擎。
 * UI 节点通过 fx(ui) 更新运行时界面；需要后端能力的节点走 ctx.rpc；
 * 子蓝图入口/出口是系统节点，端口由子蓝图接口动态驱动（见 store.ts dynamicDefs）。
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
  {
    id: 'event/uiClick',
    alias: '事件.按钮点击',
    title: '按钮点击',
    category: 'event',
    description: 'UI 上指定按钮被点击时触发',
    inputs: [],
    outputs: [{ id: 'exec', label: '', type: 'exec' }],
    params: [
      {
        key: 'component',
        label: '按钮组件',
        valueType: 'uicomponent',
        componentKinds: ['button'],
      },
    ],
    run: () => ({ exec: 'exec' }),
  },
  {
    id: 'event/uiChange',
    alias: '事件.值变化',
    title: '值变化',
    category: 'event',
    description: 'UI 上输入框/选择器/开关的值变化时触发',
    inputs: [],
    outputs: [
      { id: 'exec', label: '', type: 'exec' },
      { id: 'value', label: '新值', type: 'any' },
    ],
    params: [
      {
        key: 'component',
        label: '组件',
        valueType: 'uicomponent',
        componentKinds: ['input', 'select', 'switch'],
      },
    ],
    run: (_i, ctx) => ({
      exec: 'exec',
      outputs: { value: ctx.event?.value },
    }),
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
    description: '等待若干毫秒后继续（异步节点）',
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
    run: (i, ctx) => ({
      outputs: {
        out: str(ctx.params.template)
          .replaceAll('{1}', str(i.a1))
          .replaceAll('{2}', str(i.a2))
          .replaceAll('{3}', str(i.a3)),
      },
    }),
  },
  {
    id: 'transform/toJson',
    alias: '处理.转JSON',
    title: '转JSON',
    category: 'transform',
    pure: true,
    description: '把多个值组装成 JSON 对象（如列表行），键名用逗号分隔',
    inputs: [
      { id: 'a1', label: '值1', type: 'any' },
      { id: 'a2', label: '值2', type: 'any' },
      { id: 'a3', label: '值3', type: 'any' },
      { id: 'a4', label: '值4', type: 'any' },
      { id: 'a5', label: '值5', type: 'any' },
    ],
    outputs: [{ id: 'json', label: 'JSON', type: 'string' }],
    params: [
      { key: 'keys', label: '键名', valueType: 'string', default: 'time,kind,message' },
    ],
    run: (i, ctx) => {
      const keys = str(ctx.params.keys)
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
      const obj: Record<string, unknown> = {}
      keys.forEach((k, idx) => {
        obj[k] = i[`a${idx + 1}`]
      })
      return { outputs: { json: JSON.stringify(obj) } }
    },
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

  // ── 界面（与 UI 编辑器拼出的界面双向通讯） ──
  {
    id: 'ui/get',
    alias: '界面.读值',
    title: '读取界面值',
    category: 'ui',
    pure: true,
    description: '读取 UI 组件的当前值（输入框内容、选择器选中项、开关状态…）',
    inputs: [],
    outputs: [{ id: 'value', label: '值', type: 'any' }],
    params: [
      {
        key: 'component',
        label: '组件',
        valueType: 'uicomponent',
        componentKinds: ['input', 'select', 'switch', 'text', 'markdown', 'textarea', 'list'],
      },
    ],
    run: (_i, ctx) => ({ outputs: { value: ctx.ui[str(ctx.params.component)] } }),
  },
  {
    id: 'ui/set',
    alias: '界面.写值',
    title: '设置界面值',
    category: 'ui',
    description: '把文本/Markdown 等写入 UI 组件',
    inputs: [
      { id: 'exec', label: '', type: 'exec' },
      { id: 'value', label: '值', type: 'string' },
    ],
    outputs: [{ id: 'exec', label: '', type: 'exec' }],
    params: [
      {
        key: 'component',
        label: '组件',
        valueType: 'uicomponent',
        componentKinds: ['text', 'markdown', 'textarea'],
      },
    ],
    run: (i, ctx) => ({
      exec: 'exec',
      fx: [uiFx(ctx.params.component, 'set', { value: i.value })],
    }),
  },
  {
    id: 'ui/listAdd',
    alias: '界面.列表添加',
    title: '列表·添加行',
    category: 'ui',
    description: '向 UI 列表追加一行数据（JSON，键对应列表的列定义）',
    inputs: [
      { id: 'exec', label: '', type: 'exec' },
      { id: 'row', label: '行JSON', type: 'string' },
    ],
    outputs: [{ id: 'exec', label: '', type: 'exec' }],
    params: [
      { key: 'component', label: '列表', valueType: 'uicomponent', componentKinds: ['list'] },
    ],
    run: (i, ctx) => {
      let row: Record<string, unknown> = {}
      try {
        row = JSON.parse(str(i.row) || '{}')
      } catch {
        row = { message: str(i.row) }
      }
      return { exec: 'exec', fx: [uiFx(ctx.params.component, 'listAdd', { row })] }
    },
  },
  {
    id: 'ui/listClear',
    alias: '界面.列表清空',
    title: '列表·清空',
    category: 'ui',
    description: '清空 UI 列表的所有行',
    inputs: [{ id: 'exec', label: '', type: 'exec' }],
    outputs: [{ id: 'exec', label: '', type: 'exec' }],
    params: [
      { key: 'component', label: '列表', valueType: 'uicomponent', componentKinds: ['list'] },
    ],
    run: (_i, ctx) => ({ exec: 'exec', fx: [uiFx(ctx.params.component, 'clear', {})] }),
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
        default:
          '## 报表（{{dateRange}}）\n\n- 崩溃率：{{crashFreeRate}}\n\n| 错误 | 次数 |\n|---|---|\n{{#each topErrors}}| {{name}} | {{count}} |\n{{/each}}',
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
                  body.replace(/\{\{(\w+)\}\}/g, (_2, k: string) => str((row as never)[k])),
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

  // ── 子蓝图系统节点（每个子图自动包含；端口由子蓝图接口动态驱动） ──
  {
    id: 'sub/input',
    alias: '子图.入口',
    title: '子图入口',
    category: 'subgraph',
    description: '子蓝图执行的起点，输出调用方传入的参数',
    inputs: [],
    outputs: [{ id: 'exec', label: '', type: 'exec' }],
    run: () => ({ exec: 'exec' }),
  },
  {
    id: 'sub/output',
    alias: '子图.出口',
    title: '子图出口',
    category: 'subgraph',
    description: '结束子蓝图并返回值（可放置多个出口）',
    inputs: [{ id: 'exec', label: '', type: 'exec' }],
    outputs: [],
    run: () => ({}),
  },
]

export const registryById: Record<string, NodeDef> = Object.fromEntries(
  registry.map((n) => [n.id, n]),
)

export const registryByAlias: Record<string, NodeDef> = Object.fromEntries(
  registry.map((n) => [n.alias, n]),
)

/** 子蓝图调用节点的动态 def（`sub/<subId>`），随插件子蓝图定义生成 */
export function makeSubgraphNodeDef(sub: {
  id: string
  name: string
  params: { name: string; type: 'string' | 'number' | 'boolean' }[]
  returns: { name: string; type: 'string' | 'number' | 'boolean' }[]
}): NodeDef {
  return {
    id: `sub/${sub.id}`,
    alias: `子图.${sub.name}`,
    title: `调用：${sub.name}`,
    category: 'subgraph',
    description: `调用子蓝图「${sub.name}」（参数 ${sub.params.length} · 返回 ${sub.returns.length}）`,
    inputs: [
      { id: 'exec', label: '', type: 'exec' },
      ...sub.params.map((p) => ({ id: p.name, label: p.name, type: p.type as never })),
    ],
    outputs: [
      { id: 'exec', label: '', type: 'exec' },
      ...sub.returns.map((p) => ({ id: p.name, label: p.name, type: p.type as never })),
    ],
    // 由解释器特判执行（需要递归进入子图），不会调用这个 run
    run: () => ({ exec: 'exec' }),
  }
}
