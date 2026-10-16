/**
 * 脚本 DSL 往返一致性检查：
 *   npx tsx script-check.ts
 * 模板图 → serialize → parse → 与原图做语义等价比较（节点/边/参数/变量）。
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

for (const plugin of templates) {
  const text = serializeScript({
    name: plugin.name,
    middlewareName: 'Dolphin',
    vars: plugin.vars,
    graph: plugin.graph,
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
        problems.push(`var[${i}] 不一致: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)
      }
    }
  }

  const nodeKey = (n: { id: string; defId: string; params: Record<string, unknown> }) =>
    `${n.id}|${n.defId}|${JSON.stringify(n.params, Object.keys(n.params).sort())}`
  const aNodes = [...parsed.graph.nodes].map(nodeKey).sort()
  const bNodes = [...plugin.graph.nodes].map(nodeKey).sort()
  if (aNodes.join(';') !== bNodes.join(';')) {
    problems.push(`节点不一致:\n  脚本: ${aNodes.join('\n  脚本: ')}\n  原图: ${bNodes.join('\n  原图: ')}`)
  }

  const edgeKey = (e: { source: string; sourcePort: string; target: string; targetPort: string }) =>
    `${e.source}.${e.sourcePort}->${e.target}.${e.targetPort}`
  const aEdges = [...parsed.graph.edges].map(edgeKey).sort()
  const bEdges = [...plugin.graph.edges].map(edgeKey).sort()
  if (aEdges.join(';') !== bEdges.join(';')) problems.push(`边不一致:\n  ${aEdges}\n  ${bEdges}`)

  if (problems.length) {
    failed++
    console.error(`✕「${plugin.name}」往返失败:`)
    for (const p of problems) console.error(`   - ${p}`)
  } else {
    console.log(`✓「${plugin.name}」脚本往返一致（${parsed.graph.nodes.length} 节点 / ${parsed.graph.edges.length} 边）`)
  }
}

if (failed) {
  console.error(`\n${failed} 个模板往返失败`)
  process.exit(1)
}
console.log('\n全部模板蓝图⇄脚本往返一致 ✓')
