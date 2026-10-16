/**
 * 脚本 DSL 往返一致性检查：
 *   npx tsx script-check.ts
 * 模板图（含子蓝图段落）→ serialize → parse → 与原图做语义等价比较。
 */
import { parseScript, serializeScript } from './src/script'
import { buildPlugin } from './src/templates'
import type { PluginRecord } from './src/types'

const templates: PluginRecord[] = [
  buildPlugin('check-1', 'mw', '日志查看器', 'logviewer'),
  buildPlugin('check-2', 'mw', '错误报表', 'report'),
  buildPlugin('check-3', 'mw', '空白', 'blank'),
]

let failed = 0

type GraphLike = {
  nodes: { id: string; defId: string; params: Record<string, unknown> }[]
  edges: { source: string; sourcePort: string; target: string; targetPort: string }[]
}

function graphKey(g: GraphLike) {
  const nodes = [...g.nodes]
    .map((n) => `${n.id}|${n.defId}|${JSON.stringify(n.params)}`)
    .sort()
  const edges = [...g.edges]
    .map((e) => `${e.source}.${e.sourcePort}->${e.target}.${e.targetPort}`)
    .sort()
  return { nodes: nodes.join(';'), edges: edges.join(';') }
}

for (const plugin of templates) {
  const text = serializeScript({
    name: plugin.name,
    middlewareName: 'Dolphin',
    vars: plugin.vars,
    graph: plugin.graph,
    subgraphs: plugin.subgraphs,
  })
  const parsed = parseScript(text)

  const problems: string[] = []
  if (parsed.name !== plugin.name) problems.push(`name: ${parsed.name} != ${plugin.name}`)
  if (parsed.vars.length !== plugin.vars.length) problems.push('var 数量不一致')
  else {
    for (let i = 0; i < parsed.vars.length; i++) {
      const a = parsed.vars[i]
      const b = plugin.vars[i]
      if (a.name !== b.name || a.type !== b.type || String(a.default) !== String(b.default)) {
        problems.push(`var[${i}] 不一致`)
      }
    }
  }

  const aMain = graphKey(parsed.graph)
  const bMain = graphKey(plugin.graph)
  if (aMain.nodes !== bMain.nodes || aMain.edges !== bMain.edges) {
    problems.push(`主图不一致:\n  脚本nodes: ${aMain.nodes}\n  原图nodes: ${bMain.nodes}\n  脚本edges: ${aMain.edges}\n  原图edges: ${bMain.edges}`)
  }

  if (parsed.subgraphs.length !== plugin.subgraphs.length) {
    problems.push(`子蓝图数量: ${parsed.subgraphs.length} != ${plugin.subgraphs.length}`)
  } else {
    for (let i = 0; i < parsed.subgraphs.length; i++) {
      const a = parsed.subgraphs[i]
      const b = plugin.subgraphs[i]
      const subProblems: string[] = []
      if (a.id !== b.id) subProblems.push('id')
      if (a.name !== b.name) subProblems.push('name')
      if (JSON.stringify(a.params) !== JSON.stringify(b.params)) subProblems.push('params')
      if (JSON.stringify(a.returns) !== JSON.stringify(b.returns)) subProblems.push('returns')
      const ag = graphKey(a.graph)
      const bg = graphKey(b.graph)
      if (ag.nodes !== bg.nodes || ag.edges !== bg.edges) subProblems.push(`图内容\n    脚本nodes: ${ag.nodes}\n    原图nodes: ${bg.nodes}\n    脚本edges: ${ag.edges}\n    原图edges: ${bg.edges}`)
      if (subProblems.length) problems.push(`子蓝图[${i}] 差异: ${subProblems.join(', ')}`)
    }
  }

  if (problems.length) {
    failed++
    console.error(`✕「${plugin.name}」往返失败:`)
    for (const p of problems) console.error(`   - ${p}`)
  } else {
    console.log(
      `✓「${plugin.name}」往返一致（主图 ${parsed.graph.nodes.length} 节点 / ${parsed.subgraphs.length} 个子蓝图）`,
    )
  }
}

if (failed) {
  console.error(`\n${failed} 个模板往返失败`)
  process.exit(1)
}
console.log('\n全部模板蓝图⇄脚本往返一致（含子蓝图段落）✓')
