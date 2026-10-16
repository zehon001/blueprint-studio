import { registryByAlias, registryById } from './nodeRegistry'
import type { NodeDef, ParamDef, SerializedGraph, VariableDef } from './types'

/**
 * 蓝图脚本 DSL —— 与节点图双向无损互转（类似 UE5 的蓝图⇄文本互转）。
 *
 *   plugin 日志查看器 @ Dolphin
 *   var packageName = "com.dolphin.game" : string
 *   node srcDemo = 源.演示日志(preset="dolphin", rate=3)
 *   edge onlog.exec -> b1.exec
 *
 * 节点用注册表别名（或 id）引用；参数按定义类型序列化；节点坐标不进脚本
 * （回到蓝图时保留已有节点位置，新节点自动排布后可用「自动布局」整理）。
 */

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

export function serializeScript(plugin: {
  name: string
  middlewareName: string
  vars: VariableDef[]
  graph: SerializedGraph
}): string {
  const lines: string[] = []
  lines.push(`# Blueprint Script — 可与蓝图双向互转`)
  lines.push(`plugin ${plugin.name} @ ${plugin.middlewareName}`)
  lines.push('')
  for (const v of plugin.vars) {
    lines.push(`var ${v.name} = ${JSON.stringify(v.default ?? '')} : ${v.type}`)
  }
  if (plugin.vars.length) lines.push('')
  for (const node of plugin.graph.nodes) {
    const def = registryById[node.defId]
    if (!def) continue
    const params = def.params ?? []
    const rendered = params
      .map((p) => `${p.key}=${escapeValue(node.params?.[p.key] ?? p.default, p.valueType)}`)
      .join(', ')
    lines.push(`node ${node.id} = ${def.alias}${params.length ? `(${rendered})` : ''}`)
  }
  lines.push('')
  for (const e of plugin.graph.edges) {
    lines.push(`edge ${e.source}.${e.sourcePort} -> ${e.target}.${e.targetPort}`)
  }
  return lines.join('\n') + '\n'
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
} {
  const rawLines = text.split('\n')
  const vars: VariableDef[] = []
  const nodes: SerializedGraph['nodes'] = []
  const edges: SerializedGraph['edges'] = []

  const varRe = /^var\s+([\w\u4e00-\u9fa5.-]+)\s*=\s*(.+?)\s*:\s*(string|number|boolean)$/
  const nodeRe = /^node\s+([\w\u4e00-\u9fa5.-]+)\s*=\s*(.+?)(\((.*)\))?\s*$/
  const edgeRe = /^edge\s+([\w\u4e00-\u9fa5.-]+)\.([\w-]+)\s*->\s*([\w\u4e00-\u9fa5.-]+)\.([\w-]+)$/
  const pluginRe = /^plugin\s+(.+?)\s*@\s*(.+)$/

  let name = '未命名插件'
  let middlewareName = '未分组'
  let seenPlugin = false

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

    const nodeMatch = line.match(nodeRe)
    if (nodeMatch) {
      const nodeId = nodeMatch[1]
      const defRef = nodeMatch[2].trim()
      const def: NodeDef | undefined = registryByAlias[defRef] ?? registryById[defRef]
      if (!def) throw new ScriptParseError(`未知节点「${defRef}」`, lineNo)
      if (nodes.some((n) => n.id === nodeId)) {
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
      nodes.push({ id: nodeId, defId: def.id, position: { x: 0, y: 0 }, params })
      return
    }

    const edgeMatch = line.match(edgeRe)
    if (edgeMatch) {
      const [, source, sourcePort, target, targetPort] = edgeMatch
      const sourceDef = nodes.find((n) => n.id === source)
      const targetDef = nodes.find((n) => n.id === target)
      if (!sourceDef) throw new ScriptParseError(`连线起点不存在「${source}」`, lineNo)
      if (!targetDef) throw new ScriptParseError(`连线终点不存在「${target}」`, lineNo)
      edges.push({
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

  return { name, middlewareName, vars, graph: { nodes, edges } }
}
