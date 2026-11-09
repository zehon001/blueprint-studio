/**
 * 文件系统虚拟根映射单测
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASSETS_ROOT,
  INTERNAL_FUNCTION_DIR,
  assetPathOfDisplay,
  buildMergedTree,
  displayPathForProjectRel,
  displayToRealPath,
  internalLibraryEntryName,
  projectRelPathOfDisplay,
  virtualZoneOf,
} from './virtual-roots'
import { findNode, type FsNode } from './tree-model'

function dir(name: string, path: string, children: FsNode[] = []): FsNode {
  return { name, path, type: 'dir', ext: '', children }
}

function file(name: string, path: string): FsNode {
  return { name, path, type: 'file', ext: 'json', children: [] }
}

test('virtualZoneOf：两个分区与根', () => {
  assert.equal(virtualZoneOf('@fs'), 'root')
  assert.equal(virtualZoneOf(ASSETS_ROOT), 'assets')
  assert.equal(virtualZoneOf(`${ASSETS_ROOT}/blueprint/main.bp.json`), 'assets')
  assert.equal(virtualZoneOf('@fs/internal-library/functions/a.fn.json'), 'internal-library')
  assert.equal(virtualZoneOf('P/blueprint/main.bp.json'), null)
})

test('displayPathForProjectRel / projectRelPathOfDisplay：assets 双向映射（含项目库）', () => {
  assert.equal(displayPathForProjectRel(''), ASSETS_ROOT)
  assert.equal(displayPathForProjectRel('blueprint/main.bp.json'), `${ASSETS_ROOT}/blueprint/main.bp.json`)
  assert.equal(
    displayPathForProjectRel('library/functions/fmt.fn.json'),
    `${ASSETS_ROOT}/library/functions/fmt.fn.json`,
  )
  assert.equal(projectRelPathOfDisplay(`${ASSETS_ROOT}/blueprint/main.bp.json`), 'blueprint/main.bp.json')
  assert.equal(
    projectRelPathOfDisplay(`${ASSETS_ROOT}/library/functions/fmt.fn.json`),
    'library/functions/fmt.fn.json',
  )
  assert.equal(displayToRealPath('P', `${ASSETS_ROOT}/blueprint/main.bp.json`), 'P/blueprint/main.bp.json')
  assert.equal(
    displayToRealPath('P', `${ASSETS_ROOT}/library/functions/fmt.fn.json`),
    'P/library/functions/fmt.fn.json',
  )
})

test('assetPathOfDisplay / internalLibraryEntryName：资产路径与内置库条目映射', () => {
  assert.equal(assetPathOfDisplay(`${ASSETS_ROOT}/blueprint/main.bp.json`), 'blueprint/main.bp.json')
  assert.equal(
    assetPathOfDisplay(`${ASSETS_ROOT}/library/functions/fmt.fn.json`),
    'library/functions/fmt.fn.json',
  )
  assert.equal(
    assetPathOfDisplay(`${INTERNAL_FUNCTION_DIR}/fmt.fn.json`),
    '@library/functions/fmt',
  )
  assert.equal(internalLibraryEntryName(`${INTERNAL_FUNCTION_DIR}/fmt.fn.json`), 'fmt')
  assert.equal(assetPathOfDisplay(INTERNAL_FUNCTION_DIR), null)
})

test('buildMergedTree：assets 保留 library，内置库显示 functions 目录', () => {
  const projectTree = dir('P', 'P', [
    file('project.json', 'P/project.json'),
    dir('blueprint', 'P/blueprint', [file('main.bp.json', 'P/blueprint/main.bp.json')]),
    dir('library', 'P/library', [
      dir('functions', 'P/library/functions', [
        file('fmt.fn.json', 'P/library/functions/fmt.fn.json'),
      ]),
    ]),
  ])
  const tree = buildMergedTree({
    projectName: 'P',
    projectTree,
    builtinFunctions: [{ name: 'log' }],
  })

  assert.deepEqual(
    tree.children.map((c) => c.name),
    ['assets', 'internal-library'],
  )
  assert.equal(findNode(tree, `${ASSETS_ROOT}/blueprint/main.bp.json`)?.type, 'file')
  assert.equal(findNode(tree, `${ASSETS_ROOT}/project.json`), null, 'project.json 应从文件树隐藏')
  assert.equal(
    findNode(tree, `${ASSETS_ROOT}/library/functions/fmt.fn.json`)?.type,
    'file',
    '项目库 library 照常显示在 assets 下',
  )
  assert.equal(findNode(tree, `${INTERNAL_FUNCTION_DIR}/log.fn.json`)?.type, 'file')
  assert.equal(findNode(tree, '@fs/internal-library/function/log.fn.json'), null, '目录名为 functions')
})
