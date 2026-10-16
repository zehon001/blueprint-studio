import { registryByAlias, registryById } from './nodeRegistry'
import type {
  NodeDef,
  ParamDef,
  SerializedGraph,
  SubgraphDef,
  SubgraphPort,
  VariableDef,
} from './types'

/**
 * 蓝图脚本 DSL —— 与节点图双向无损互转（类似 UE5 的蓝图⇄文本互转）。
 *
 *   plugin 日志查看器 @ Dolphin
 *   var packageName = "com.dolphin.game" : string
 *   node onlog = 事件.日志行(source="srcDemo")
 *   edge onlog.exec -> parse.exec
 *   sub parse 解析日志行 (line: string, ts: string) -> (row: string)
 *   node sin = 子图.入口()
 *   edge sin.exec -> ...
 *
 * 主图的 node/edge 写在 sub 段落之前；每个 `sub` 行开启一个子蓝图段落，
 * 之后的 node/edge 归属该子图。节点坐标不进脚本。
 */

const SUB_RE = /^sub\s+([\w\u4e00-\u9fa5.-]+)\s+(.+?)\s*\((.*?)\)\s*->\s*\((.*)\)$/

function escapeValue(value: unknown, valueType: ParamDef['valueType']): string {
  if (valueType === 'number') return String(Number(value) || 0)
  if (valueType === 'boolean') return String(Boolean(value))
  return JSON.stringify(value == null ? '' : String(value))
}

function parseScalar(text: string, valueType: ParamDef['valueType']): unknown {
  if (valueType === 'number') return Number(text) || 0
  if (valueType === 'boolean') return text === 'true'
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function parsePortList(text: string): SubgraphPort[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [name, type] = pair.split(':').map((s) => s.trim())
      return { name, type: (type || 'string') as SubgraphPort['type'] }
    })
}

function serializeGraphInto(
  lines: string[],
  graph: SerializedGraph,
  resolveDef: (defId: string) => NodeDef | undefined,
) {
  for (const node of graph.nodes) {
    const def = resolveDef(node.defId)
    if (!def) continue
    const params = def.params ?? []
    const rendered = params
      .map((p) => `${p.key}=${escapeValue(node.params?.[p.key] ?? p.default, p.valueType)}`)
      .join(', ')
    lines.push(`node ${node.id} = ${def.alias}${params.length ? `(${rendered})` : ''}`)
  }
  for (const e of graph.edges) {
    lines.push(`edge ${e.source}.${e.sourcePort} -> ${e.target}.${e.targetPort}`)
  }
}

export function serializeScript(plugin: {
  name: string
  middlewareName: string
  vars: VariableDef[]
  graph: SerializedGraph
  subgraphs: SubgraphDef[]
}): string {
  const lines: string[] = []
  lines.push(`# Blueprint Script — 可与蓝图双向互转`)
  lines.push(`plugin ${plugin.name} @ ${plugin.middlewareName}`)
  lines.push('')
  for (const v of plugin.vars) {
    lines.push(`var ${v.name} = ${JSON.stringify(v.default ?? '')} : ${v.type}`)
  }
  if (plugin.vars.length) lines.push('')

  const subDefs = new Map(plugin.subgraphs.map((s) => [`sub/${s.id}`, s]))
  const resolveDef = (defId: string): NodeDef | undefined => {
    const staticDef = registryById[defId]
    if (staticDef) return staticDef
    const sub = subDefs.get(defId)
    if (!sub) return undefined
    return {
      id: defId,
      alias: `子图.${sub.name}`,
      title: sub.name,
      category: 'subgraph',
      description: '',
      inputs: [],
      outputs: [],
      run: () => ({}),
      params: [],
    }
  }

  serializeGraphInto(lines, plugin.graph, resolveDef)
  lines.push('')

  for (const sub of plugin.subgraphs) {
    const params = sub.params.map((p) => `${p.name}: ${p.type}`).join(', ')
    const returns = sub.returns.map((p) => `${p.name}: ${p.type}`).join(', ')
    lines.push(`sub ${sub.id} ${sub.name} (${params}) -> (${returns})`)
    serializeGraphInto(lines, sub.graph, resolveDef)
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}

function splitParams(text: string): string[] {
  const out: string[] = []
  let current = ''
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\' && inString) {
      current += ch
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      current += ch
      continue
    }
    if (ch === ',' && !inString) {
      out.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) out.push(current.trim())
  return out
}

export class ScriptParseError extends Error {
  constructor(
    message: string,
    readonly lineNo: number,
  ) {
    super(`第 ${lineNo} 行：${message}`)
  }
}

export function parseScript(text: string): {
  name: string
  middlewareName: string
  vars: VariableDef[]
  graph: SerializedGraph
  subgraphs: SubgraphDef[]
} {
  const rawLines = text.split('\n')
  const vars: VariableDef[] = []
  const subgraphs: SubgraphDef[] = []
  const graph: SerializedGraph = { nodes: [], edges: [] }

  const varRe = /^var\s+([\w\u4e00-\u9fa5.-]+)\s*=\s*(.+?)\s*:\s*(string|number|boolean)$/
  const nodeRe = /^node\s+([\w\u4e00-\u9fa5.-]+)\s*=\s*(.+?)(\((.*)\))?\s*$/
  const edgeRe = /^edge\s+([\w\u4e00-\u9fa5.-]+)\.([\w-]+)\s*->\s*([\w\u4e00-\u9fa5.-]+)\.([\w-]+)$/
  const pluginRe = /^plugin\s+(.+?)\s*@\s*(.+)$/

  let name = '未命名插件'
  let middlewareName = '未分组'
  let seenPlugin = false
  let current: SerializedGraph = graph

  // 预扫描：先收集全部子蓝图头（主图节点可能前向引用子图调用）
  for (const raw of rawLines) {
    const subMatch = raw.trim().match(SUB_RE)
    if (subMatch) {
      subgraphs.push({
        id: subMatch[1],
        name: subMatch[2].trim(),
        params: parsePortList(subMatch[3]),
        returns: parsePortList(subMatch[4]),
        graph: { nodes: [], edges: [] },
      })
    }
  }

  rawLines.forEach((raw, i) => {
    const line = raw.trim()
    const lineNo = i + 1
    if (!line || line.startsWith('#')) return

    const pluginMatch = line.match(pluginRe)
    if (pluginMatch) {
      name = pluginMatch[1].trim()
      middlewareName = pluginMatch[2].trim()
      seenPlugin = true
      return
    }

    const varMatch = line.match(varRe)
    if (varMatch) {
      let def: unknown = ''
      try {
        def = JSON.parse(varMatch[2])
      } catch {
        def = varMatch[2]
      }
      vars.push({ name: varMatch[1], type: varMatch[3] as VariableDef['type'], default: def })
      return
    }

    const subMatch = line.match(SUB_RE)
    if (subMatch) {
      const sub = subgraphs.find((s) => s.id === subMatch[1])
      if (!sub) throw new ScriptParseError(`子蓝图重复或异常「${subMatch[1]}」`, lineNo)
      current = sub.graph
      return
    }

    const nodeMatch = line.match(nodeRe)
    if (nodeMatch) {
      const nodeId = nodeMatch[1]
      const defRef = nodeMatch[2].trim()
      const def: NodeDef | undefined = registryByAlias[defRef] ?? registryById[defRef]
      if (!def) {
        // 可能是子蓝图调用节点
        const subName = defRef.startsWith('子图.') ? defRef.slice(3) : defRef
        const sub = subgraphs.find((s) => s.name === subName || s.id === subName)
        if (!sub) throw new ScriptParseError(`未知节点「${defRef}」`, lineNo)
        if (current.nodes.some((n) => n.id === nodeId)) {
          throw new ScriptParseError(`节点 id 重复「${nodeId}」`, lineNo)
        }
        current.nodes.push({ id: nodeId, defId: `sub/${sub.id}`, position: { x: 0, y: 0 }, params: {} })
        return
      }
      if (current.nodes.some((n) => n.id === nodeId)) {
        throw new ScriptParseError(`节点 id 重复「${nodeId}」`, lineNo)
      }
      const params: Record<string, unknown> = {}
      for (const p of def.params ?? []) params[p.key] = p.default
      const paramsText = nodeMatch[4] ?? ''
      if (paramsText.trim()) {
        for (const kv of splitParams(paramsText)) {
          const eq = kv.indexOf('=')
          if (eq <= 0) throw new ScriptParseError(`参数格式错误「${kv}」`, lineNo)
          const key = kv.slice(0, eq).trim()
          const valueText = kv.slice(eq + 1).trim()
          const paramDef = (def.params ?? []).find((p) => p.key === key)
          if (!paramDef) throw new ScriptParseError(`节点 ${def.alias} 没有参数「${key}」`, lineNo)
          params[key] = parseScalar(valueText, paramDef.valueType)
        }
      }
      current.nodes.push({ id: nodeId, defId: def.id, position: { x: 0, y: 0 }, params })
      return
    }

    const edgeMatch = line.match(edgeRe)
    if (edgeMatch) {
      const [, source, sourcePort, target, targetPort] = edgeMatch
      if (!current.nodes.some((n) => n.id === source)) {
        throw new ScriptParseError(`连线起点不存在「${source}」`, lineNo)
      }
      if (!current.nodes.some((n) => n.id === target)) {
        throw new ScriptParseError(`连线终点不存在「${target}」`, lineNo)
      }
      current.edges.push({
        id: `e-${source}-${sourcePort}-${target}-${targetPort}`,
        source,
        sourcePort,
        target,
        targetPort,
      })
      return
    }

    throw new ScriptParseError(`无法解析「${line}」`, lineNo)
  })

  if (!seenPlugin) throw new ScriptParseError('缺少 plugin 声明行', 1)

  return { name, middlewareName, vars, graph, subgraphs }
}
