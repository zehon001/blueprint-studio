/** 分节文本模型单测：角色卡【标题】与规范 Markdown 标题的往返。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectNormsStyle,
  joinBracketSections,
  joinMarkdownSections,
  joinSections,
  splitBracketSections,
  splitMarkdownSections,
  splitSections,
} from './section-model'

test('角色卡分节：开场 + 【标题】往返', () => {
  const source = '你是小蓝。\n\n【职责】\n负责客服。\n\n【边界】\n不承诺退款。'
  const sections = splitBracketSections(source)
  assert.equal(sections.length, 3)
  assert.equal(sections[0]!.title, '')
  assert.match(sections[0]!.text, /你是小蓝/)
  assert.equal(sections[1]!.title, '职责')
  assert.equal(sections[1]!.text, '负责客服。')
  assert.equal(joinBracketSections(sections), source)
})

test('规范分节：Markdown ## 标题往返', () => {
  const source = '# 工作规范\n\n## 文件操作\n- 先读后写。\n\n## 工具\n- 失败先看报错。'
  const sections = splitMarkdownSections(source)
  assert.equal(sections.length, 3)
  assert.equal(sections[1]!.title, '文件操作')
  assert.equal(sections[2]!.title, '工具')
  assert.equal(joinMarkdownSections(sections), source)
})

test('规范样式识别：Markdown / 【】 / 默认【】', () => {
  assert.equal(detectNormsStyle('## 文件\n- x'), 'markdown')
  assert.equal(detectNormsStyle('【文件】\n- x'), 'bracket')
  assert.equal(detectNormsStyle('普通规范文本'), 'bracket')
  assert.equal(joinSections(splitSections('## A\nx', 'markdown'), 'markdown'), '## A\nx')
})
