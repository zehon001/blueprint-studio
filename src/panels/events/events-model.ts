/**
 * 事件面板纯函数层（T5.2 · PLAN §11 事件面板）
 *
 * 无 React / DOM 依赖（node:test 可直接单测）：
 *  - builtinEventRows / customEventRows / scanScriptEvents：三路事件清单来源——
 *    ① 选中 UI 节点的 schema.events（内建，事件名 + 中文 label）；
 *    ② 逻辑资产 .bp.json 的 asset.events（自定义，含参数签名）；
 *    ③ 逻辑资产 .ts 源码的 @on(...) 轻量正则粗扫（解析器重，精确列表在脚本编辑器诊断区）；
 *  - assembleEventRows / withEntryFlags：两节列表组装 + 「已有入口节点」徽标
 *    （逻辑资产 IR 中按 params.eventName 定位 event.custom，与解释器
 *    customEventName 同口径：params.eventName 优先，title 命中已声明事件名回退）；
 *  - findCustomEventNodes：event.custom 入口定位（DoD 单测 3；全图扫描，entry 图优先）；
 *  - resolveDoubleClick：双击意图解析（DoD 单测 2）——无资产 → 提示；已有入口 →
 *    跳转目标；缺失 → 创建 action 参数（内建 = addNode+setNodeParams，
 *    自定义 = insertEventNode，见 blueprint-bridge.ts 的执行端）；
 *  - entryInsertPosition：入口图内新事件节点的落点（现有节点最低点下方错开）。
 *
 * 契约真源：src/ir/types.ts（IRAsset / IRNode / UINode）与 src/ui-editor/schema（BuiltInEvent）。
 */
import type { IRAsset, IRParamSpec, UINode, Vec2 } from '@/ir/types'
import type { BuiltInEvent } from '@/ui-editor/schema'
import { getUISchema } from '@/ui-editor/schema'

/* ============================================================
 * 1. 事件行模型与三路来源
 * ============================================================ */

/** 事件行（面板列表的统一展示单元） */
export interface EventRowModel {
  /** 事件名（内建如 'pressed'；自定义如 'loaded'；双击创建 / 跳转的唯一键） */
  name: string
  /** 显示名（内建 = schema 中文 label；自定义 = 事件名本身） */
  label: string
  /** 来源：builtin = UI 节点内建事件；custom = 逻辑资产自定义事件 */
  source: 'builtin' | 'custom'
  /** 参数签名文本（如 '(count: float)'；无参数 = '()'；内建事件省略） */
  signature?: string
  /** 逻辑资产中是否已有 event.custom 入口节点（仅 .bp.json 且解析成功时计算） */
  entry?: boolean
}

/** 内建事件声明 → 行（纯映射；schema 缺失 / events 为空返回空数组） */
export function builtinEventRows(events: readonly BuiltInEvent[] | undefined): EventRowModel[] {
  return (events ?? []).map((ev) => ({
    name: ev.name,
    label: ev.label,
    source: 'builtin' as const,
  }))
}

/** 参数声明 → 签名文本（'(count: float, tag: string)'；无参数为 '()'） */
export function signatureOf(params: readonly IRParamSpec[]): string {
  return `(${params.map((p) => `${p.name}: ${p.type}`).join(', ')})`
}

/** IR 自定义事件表 → 行（含参数签名；entry 徽标由 withEntryFlags 统一补） */
export function customEventRows(ir: Pick<IRAsset, 'events'> | null): EventRowModel[] {
  return (ir?.events ?? []).map((ev) => ({
    name: ev.name,
    label: ev.name,
    source: 'custom' as const,
    signature: signatureOf(ev.params ?? []),
  }))
}

/**
 * .ts 逻辑资产源码的 @on(...) 轻量正则粗扫 → 行（非精确解析）。
 * 口径与 src/script/parser-ts.ts 的事件表一致：
 *  - @on('名') 单参 → 自定义事件（'start' 是内建入口事件，不进事件表）；
 *  - @on('节点名', '事件名') / @on(节点名, '事件名') 双参取第二参（T2.6 语义，UI 内建事件绑定）；
 *  - @onEvent('名') → 监听目标，一并列入（解析器把两种装饰器都进 asset.events）；
 *  - 参数签名粗扫拿不到（在方法形参上），统一 '()'——精确列表在脚本编辑器诊断区。
 */
export function scanScriptEvents(source: string): EventRowModel[] {
  const callRe = /@(on|onEvent)\s*\(([^()]*)\)/g
  const strRe = /(['"])((?:\\.|(?!\1).)*)\1/g
  const out: EventRowModel[] = []
  const seen = new Set<string>()
  for (const m of source.matchAll(callRe)) {
    const deco = m[1]
    const literals: string[] = []
    for (const s of (m[2] ?? '').matchAll(strRe)) literals.push(String(s[2]).trim())
    const name = (deco === 'on' && literals.length >= 2 ? literals[1] : literals[0])?.trim() ?? ''
    if (name === '' || name === 'start' || seen.has(name)) continue
    seen.add(name)
    out.push({ name, label: name, source: 'custom', signature: '()' })
  }
  return out
}

/* ============================================================
 * 2. event.custom 入口定位（DoD 单测 3）
 * ============================================================ */

/** 事件入口节点位置（图名 + 节点实例 id） */
export interface EventNodeRef {
  graphName: string
  nodeId: string
}

/**
 * 按 params.eventName 在资产全部图中定位 event.custom 入口节点
 * （与解释器 customEventName 同口径：params.eventName 优先，回退「节点 title 命中
 * 已声明事件名」；title 回退只对已声明的自定义事件生效）。entry 图优先，其余按图序。
 */
export function findCustomEventNodes(ir: IRAsset, eventName: string): EventNodeRef[] {
  const declared = (ir.events ?? []).some((e) => e.name === eventName)
  const graphNames = Object.keys(ir.graphs ?? {})
  graphNames.sort((a, b) => {
    if (a === ir.entry) return -1
    if (b === ir.entry) return 1
    return 0
  })
  const out: EventNodeRef[] = []
  for (const graphName of graphNames) {
    for (const node of ir.graphs[graphName]?.nodes ?? []) {
      if (node.type !== 'event.custom') continue
      const byParam = node.params?.eventName === eventName
      const byTitle = declared && node.title === eventName
      if (byParam || byTitle) out.push({ graphName, nodeId: node.id })
    }
  }
  return out
}

/** 首个入口（无则 null；goto 语义的跳转目标） */
export function findFirstCustomEventNode(ir: IRAsset, eventName: string): EventNodeRef | null {
  return findCustomEventNodes(ir, eventName)[0] ?? null
}

/** 给行统一补 entry 徽标（ir 缺失 = .ts/.py 或加载失败 → 徽标不渲染，保持 undefined） */
export function withEntryFlags(
  rows: readonly EventRowModel[],
  ir: IRAsset | null | undefined,
): EventRowModel[] {
  return rows.map((row) => ({
    ...row,
    entry: ir ? findCustomEventNodes(ir, row.name).length > 0 : undefined,
  }))
}

/* ============================================================
 * 3. 列表组装（DoD 单测 1）
 * ============================================================ */

/** 逻辑资产事件解析结果（EventsPanel 拉取 /api/file 后的归一形态） */
export interface LogicEventsInfo {
  /** 逻辑资产路径（相对项目根，即 UINode.logicAsset 的值） */
  path: string
  /** 资产种类：bp = .bp.json（IR）；ts = .ts（@on 粗扫）；py = .py（暂不解析）；unknown = 无法识别的扩展名 */
  lang: 'bp' | 'ts' | 'py' | 'unknown'
  /** 自定义事件行（失败时为空） */
  events: EventRowModel[]
  /** 解析是否成功（失败 = 404 / JSON 损坏等；面板显示 message） */
  ok: boolean
  /** 失败 / 降级说明（中文） */
  message?: string
  /** 解析出的 IR（仅 bp 且成功时；双击定位 / entry 徽标用；ts / py 无） */
  ir?: IRAsset
}

/** 组装结果：两节列表 */
export interface AssembleResult {
  builtin: EventRowModel[]
  custom: EventRowModel[]
}

/**
 * 组装选中节点的两节事件列表（DoD 单测 1）：
 *  - node = null 或类型未注册 → builtin 为空；
 *  - logic = null（未绑定 / 加载失败）→ custom 为空（面板头部显示绑定状态）；
 *  - entry 徽标：logic.ir 存在时按事件名定位 event.custom（内建 + 自定义逐行补）。
 */
export function assembleEventRows(node: UINode | null, logic: LogicEventsInfo | null): AssembleResult {
  const schema = node ? getUISchema(node.type) : undefined
  const builtin = builtinEventRows(schema?.events)
  const custom = logic?.ok ? logic.events : []
  const ir = logic?.ir ?? null
  return { builtin: withEntryFlags(builtin, ir), custom: withEntryFlags(custom, ir) }
}

/* ============================================================
 * 4. 双击意图解析（DoD 单测 2）
 * ============================================================ */

/** 双击意图（解析纯函数输出；执行端在 EventsPanel / blueprint-bridge.ts） */
export type DoubleClickIntent =
  /** 节点未绑定逻辑资产 → 面板提示 +「新建蓝图并挂载」快捷按钮 */
  | { kind: 'no-logic'; message: string }
  /** 该资产形态不支持蓝图跳转 → 面板提示（.py 待 T4.x / 未知类型 / 资产加载失败） */
  | { kind: 'unsupported'; message: string }
  /** .ts 脚本资产 → 打开脚本 tab（事件在脚本视图编辑） */
  | { kind: 'open-script'; assetPath: string }
  /** 已有入口节点 → 切图 + 选中（graphName/nodeId 为跳转目标） */
  | { kind: 'goto'; graphName: string; nodeId: string; eventName: string }
  /** 内建事件缺入口 → addNode('event.custom') + setNodeParams(eventName)（自动创建） */
  | { kind: 'create-builtin'; eventName: string }
  /** 自定义事件缺入口 → 面板提示 +「一键创建」（insertEventNode） */
  | { kind: 'create-custom'; eventName: string }

/** 无逻辑资产时的提示文案（检视器 logicRef 编辑器挂载） */
export const NO_LOGIC_MESSAGE = '先在检视器挂载逻辑资产，再绑定事件'
/** 自定义事件缺入口的提示文案（配「一键创建」按钮） */
export const NO_ENTRY_MESSAGE = '蓝图无该事件入口节点'

/**
 * 双击意图解析（DoD 单测 2）：
 *  1. logic = null（节点未绑定逻辑资产）→ no-logic（面板出「新建蓝图并挂载」按钮）；
 *  2. .py / 未知类型 → unsupported（T4.x 接入前仅提示）；.ts → open-script（加载失败给错误文案）；
 *  3. .bp.json 加载失败 / IR 缺失 → unsupported（错误文案透传，不引导重复挂载）；
 *  4. IR 中已有 event.custom(eventName) → goto（首个入口，entry 图优先）；
 *  5. 缺失 → 内建 = create-builtin（自动建入口）；自定义 = create-custom（提示 + 一键创建）。
 */
export function resolveDoubleClick(row: EventRowModel, logic: LogicEventsInfo | null): DoubleClickIntent {
  if (!logic) {
    return { kind: 'no-logic', message: NO_LOGIC_MESSAGE }
  }
  if (logic.lang === 'py' || logic.lang === 'unknown') {
    return {
      kind: 'unsupported',
      message:
        logic.lang === 'py'
          ? 'Python 资产事件解析将在 T4.x 接入（当前仅列出提示）'
          : '无法识别的逻辑资产类型（支持 .bp.json / .ts / .py）',
    }
  }
  if (logic.lang === 'ts') {
    return logic.ok
      ? { kind: 'open-script', assetPath: logic.path }
      : { kind: 'unsupported', message: `脚本资产加载失败：${logic.message ?? '未知错误'}` }
  }
  // .bp.json：未加载成功 / IR 缺失时无法定位与创建（面板正文已展示具体原因）
  if (!logic.ok || !logic.ir) {
    return { kind: 'unsupported', message: logic.message ?? '逻辑资产未解析成功，无法定位事件节点' }
  }
  const hit = findFirstCustomEventNode(logic.ir, row.name)
  if (hit) {
    return { kind: 'goto', graphName: hit.graphName, nodeId: hit.nodeId, eventName: row.name }
  }
  return row.source === 'builtin'
    ? { kind: 'create-builtin', eventName: row.name }
    : { kind: 'create-custom', eventName: row.name }
}

/* ============================================================
 * 5. 入口节点落点（entry 图内错开，避免与现有节点叠放）
 * ============================================================ */

/** 入口图内新事件节点的落点：现有节点最低点下方 80px；空图给默认位 */
export function entryInsertPosition(ir: IRAsset | null | undefined): Vec2 {
  const graph = ir?.graphs[ir.entry]
  if (!graph || graph.nodes.length === 0) return { x: 120, y: 200 }
  let maxY = -Infinity
  for (const n of graph.nodes) maxY = Math.max(maxY, n.position.y)
  return { x: 120, y: maxY + 80 }
}
