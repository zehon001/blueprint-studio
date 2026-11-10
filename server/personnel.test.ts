/**
 * 人员模块单测（node:test）：
 * 人员 CRUD、类型重命名/删除、默认工作区、构建移动、STATE 续接、记忆清理、头像与提示词。
 */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildPersonWorkspace,
  clearPersonMemory,
  composeRunPrompt,
  createPerson,
  deletePerson,
  getPerson,
  getPersonMemory,
  listPeople,
  loadTypes,
  readPersonAvatar,
  resetPersonWorkspace,
  resolvePeopleRoot,
  savePersonAvatar,
  saveTypes,
  updatePerson,
} from './personnel'
import { FsError } from './fs'
import { agentGateway } from './agents/handler'

after(() => {
  agentGateway.dispose()
})

const EXTRA_DIRS: string[] = []

function makeTarget(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-target-'))
  EXTRA_DIRS.push(dir)
  return dir
}

after(() => {
  for (const dir of EXTRA_DIRS) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function withRoot(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-people-'))
  try {
    fn(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function withRootAsync(fn: (root: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-people-'))
  try {
    await fn(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe('人员默认工作区', () => {
  test('新建人员同步生成默认工作区、配置、角色卡、规范与上下文文件', () => {
    withRoot((root) => {
      process.env.BP_PEOPLE_ROOT = root
      try {
        const person = createPerson(root, { name: '小蓝', typeId: '' })
        assert.equal(person.name, '小蓝')
        assert.ok(fs.existsSync(person.defaultWorkspace))
        assert.ok(fs.existsSync(path.join(person.defaultWorkspace, '.person', 'config.json')))
        assert.ok(fs.existsSync(path.join(person.defaultWorkspace, 'AGENTS.md')))
        assert.ok(fs.existsSync(path.join(person.defaultWorkspace, 'TASK.md')))
        assert.ok(fs.existsSync(path.join(person.defaultWorkspace, 'STATE.md')))
        assert.ok(fs.existsSync(path.join(person.defaultWorkspace, 'memory', 'MEMORY.md')))

        const agents = fs.readFileSync(path.join(person.defaultWorkspace, 'AGENTS.md'), 'utf8')
        assert.match(agents, /小蓝/)
        assert.match(agents, /职责是/)
        assert.match(agents, /工作协议/)

        const list = listPeople(root)
        assert.equal(list.length, 1)
        assert.equal(list[0]!.id, person.id)
        assert.equal(list[0]!.roleCardCount, 1)
      } finally {
        delete process.env.BP_PEOPLE_ROOT
      }
    })
  })

  test('角色卡 / 规范 / 任务更新会刷新 AGENTS.md 与 TASK.md', () => {
    withRoot((root) => {
      const person = createPerson(root, { name: '测试员' })
      updatePerson(person.id, root, {
        cards: [
          {
            id: 'card-1',
            name: '排查助手',
            tags: ['排查', '日志'],
            content: '你是排查助手。\n职责是：分析日志并给出结论。',
          },
        ],
        norms: '# 规范\n- 先读文件再修改。',
        task: '排查今天的崩溃日志。',
      })
      const agents = fs.readFileSync(path.join(person.defaultWorkspace, 'AGENTS.md'), 'utf8')
      assert.match(agents, /排查助手/)
      assert.match(agents, /先读文件再修改/)
      const task = fs.readFileSync(path.join(person.defaultWorkspace, 'TASK.md'), 'utf8')
      assert.match(task, /排查今天的崩溃日志/)
    })
  })
})

describe('人员类型', () => {
  test('类型可新增 / 重命名 / 删除，删除后人员回到未分类', () => {
    withRoot((root) => {
      const person = createPerson(root, { name: '类型测试' })
      saveTypes(root, [
        { id: 'dev', name: '研发' },
        { id: 'ops', name: '运维' },
      ])
      updatePerson(person.id, root, { typeId: 'dev' })
      assert.equal(getPerson(person.id, root).typeId, 'dev')

      saveTypes(root, [{ id: 'ops', name: '运维' }])
      assert.equal(getPerson(person.id, root).typeId, '')
      assert.deepEqual(loadTypes(root), [{ id: 'ops', name: '运维' }])
    })
  })

  test('类型名称去重与空名称过滤', () => {
    withRoot((root) => {
      const types = saveTypes(root, [
        { id: 'a', name: '研发' },
        { id: 'b', name: '研发' },
        { id: 'c', name: '   ' },
      ])
      assert.equal(types.length, 1)
      assert.equal(types[0]!.name, '研发')
    })
  })
})

describe('构建工作区 / 续接', () => {
  test('构建把默认工作区文件移动到目标目录，.person 留在默认工作区', () => {
    withRoot((root) => {
      const person = createPerson(root, { name: '搬运工' })
      const target = makeTarget()
      fs.writeFileSync(path.join(person.defaultWorkspace, 'notes.txt'), 'hello', 'utf8')
      updatePerson(person.id, root, { workspace: { dir: target } })
      assert.equal(fs.existsSync(path.join(target, 'AGENTS.md')), false, '设置目录时不应提前生成目标文件')

      const result = buildPersonWorkspace(person.id, root)
      assert.equal(result.workspaceDir, target)
      assert.ok(result.moved.includes('AGENTS.md'))
      assert.ok(fs.existsSync(path.join(target, 'AGENTS.md')))
      assert.ok(fs.existsSync(path.join(target, 'TASK.md')))
      assert.ok(fs.existsSync(path.join(target, 'notes.txt')))
      assert.equal(fs.existsSync(path.join(person.defaultWorkspace, 'notes.txt')), false)
      assert.ok(fs.existsSync(path.join(person.defaultWorkspace, '.person', 'config.json')))
    })
  })

  test('STATE.md 在会话删除 / 重建 / 再次构建后保留', () => {
    withRoot((root) => {
      const person = createPerson(root, { name: '续接测试' })
      const target = makeTarget()
      updatePerson(person.id, root, { workspace: { dir: target } })
      buildPersonWorkspace(person.id, root)
      const stateFile = path.join(target, 'STATE.md')
      fs.writeFileSync(stateFile, '# 工作状态\n- 已完成：第一阶段\n', 'utf8')

      updatePerson(person.id, root, {
        cards: [{ id: 'c', name: '新卡', tags: [], content: '你是新卡。' }],
      })
      buildPersonWorkspace(person.id, root)
      assert.match(fs.readFileSync(stateFile, 'utf8'), /已完成：第一阶段/)
      assert.match(fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8'), /新卡/)
    })
  })

  test('重置工作区会重建 STATE / memory，但保留角色卡与配置', async () => {
    await withRootAsync(async (root) => {
      const person = createPerson(root, { name: '重置测试' })
      const target = makeTarget()
      updatePerson(person.id, root, { workspace: { dir: target } })
      buildPersonWorkspace(person.id, root)
      fs.writeFileSync(path.join(target, 'STATE.md'), 'custom state', 'utf8')
      fs.writeFileSync(path.join(target, 'memory', 'MEMORY.md'), 'custom memory', 'utf8')

      await resetPersonWorkspace(person.id, root)
      const detail = getPerson(person.id, root)
      assert.notEqual(fs.readFileSync(path.join(target, 'STATE.md'), 'utf8'), 'custom state')
      assert.equal(detail.memory.count, 0)
      assert.equal(detail.cards.length, 1)
      assert.equal(detail.config.workspace.builtAt, undefined)
    })
  })

  test('工作区目录必须是绝对路径', () => {
    withRoot((root) => {
      const person = createPerson(root, { name: '路径测试' })
      assert.throws(
        () => updatePerson(person.id, root, { workspace: { dir: 'relative/path' } }),
        (err: unknown) => err instanceof FsError && err.status === 400,
      )
    })
  })
})

describe('记忆 / 头像 / 提示词', () => {
  test('记忆按工作区 memory/ 汇总并可清理', () => {
    withRoot((root) => {
      const person = createPerson(root, { name: '记忆测试' })
      fs.writeFileSync(
        path.join(person.defaultWorkspace, 'memory', 'MEMORY.md'),
        '# 长期记忆\n- 主人喜欢白米饭\n- 项目代号是蓝鲸\n',
        'utf8',
      )
      const memory = getPersonMemory(person.id, root)
      assert.equal(memory.count, 2)
      assert.match(memory.text, /白米饭/)

      const cleared = clearPersonMemory(person.id, root)
      assert.equal(cleared.count, 0)
      assert.equal(getPerson(person.id, root).memory.count, 0)
    })
  })

  test('头像保存 / 读取 / 旧文件替换', () => {
    withRoot((root) => {
      const person = createPerson(root, { name: '头像测试' })
      const png =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nZcAAAAASUVORK5CYII='
      const saved = savePersonAvatar(person.id, root, { dataUrl: png })
      assert.match(saved.avatarUrl, /\/api\/personnel\/.+\/avatar/)
      const avatar = readPersonAvatar(person.id, root)
      assert.equal(avatar.mime, 'image/png')
      assert.ok(avatar.buffer.length > 0)
      assert.match(getPerson(person.id, root).avatarUrl, /avatar\?v=/)
    })
  })

  test('执行提示词包含角色卡、规范、任务、STATE 与记忆', () => {
    const config = {
      id: 'p1',
      name: '小蓝',
      typeId: '',
      createdAt: 1,
      updatedAt: 1,
      task: '完成日报',
      model: { platform: 'dsh' as const, model: '', reasoning: '', permission: '' },
      workspace: {
        dir: '',
        sessionTitle: '',
        deleteSessionAfterRun: false,
        reuseSession: true,
      },
      stats: { runs: 0, completed: 0, failed: 0 },
    }
    const prompt = composeRunPrompt(
      config,
      [{ id: 'c1', name: '日报助手', tags: ['日报'], content: '你是日报助手。职责是写日报。' }],
      '- 先读文件再写',
      '- 已完成：收集数据',
      '- 主人喜欢简洁',
    )
    assert.match(prompt, /日报助手/)
    assert.match(prompt, /先读文件再写/)
    assert.match(prompt, /完成日报/)
    assert.match(prompt, /收集数据/)
    assert.match(prompt, /主人喜欢简洁/)
    assert.match(prompt, /STATE\.md/)
  })
})

describe('删除人员', () => {
  test('删除人员会移除默认工作区目录，但保留外部工作区', async () => {
    await withRootAsync(async (root) => {
      const person = createPerson(root, { name: '删除测试' })
      const target = makeTarget()
      updatePerson(person.id, root, { workspace: { dir: target } })
      buildPersonWorkspace(person.id, root)
      await deletePerson(person.id, root)
      assert.equal(fs.existsSync(path.join(root, person.id)), false)
      assert.ok(fs.existsSync(target))
      assert.equal(listPeople(root).length, 0)
    })
  })
})

test('默认人员根目录可被环境变量覆盖', () => {
  const previous = process.env.BP_PEOPLE_ROOT
  process.env.BP_PEOPLE_ROOT = '/tmp/bps-people-test-root'
  try {
    assert.equal(resolvePeopleRoot(), '/tmp/bps-people-test-root')
  } finally {
    if (previous === undefined) delete process.env.BP_PEOPLE_ROOT
    else process.env.BP_PEOPLE_ROOT = previous
  }
})
