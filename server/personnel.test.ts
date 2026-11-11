/**
 * 人员模块单测（node:test）：
 * 人员 CRUD、类型重命名/删除、默认工作区、构建移动、STATE 续接、记忆清理、头像与启动指令。
 */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addPersonTask,
  buildPersonWorkspace,
  clearPersonMemory,
  createPerson,
  deletePersonTask,
  deletePerson,
  getPerson,
  getPersonMemory,
  getPersonTaskReport,
  listPeople,
  loadTypes,
  movePersonTask,
  PERSON_STARTUP_PROMPT,
  readPersonAvatar,
  resetPersonWorkspace,
  retryPersonTask,
  resolvePeopleRoot,
  runPerson,
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
        assert.match(agents, /【职责】/)
        assert.match(agents, /【工作原则】/)
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
      assert.match(agents, /## 当前任务/)
      assert.match(agents, /排查今天的崩溃日志/)
      assert.match(agents, /STATE\.md/)
      assert.match(agents, /memory\/MEMORY\.md/)
      const task = fs.readFileSync(path.join(person.defaultWorkspace, 'TASK.md'), 'utf8')
      assert.match(task, /排查今天的崩溃日志/)
    })
  })

  test('多张角色卡只让当前卡进入 AGENTS.md，可以随时切换', () => {
    withRoot((root) => {
      const person = createPerson(root, { name: '单卡测试' })
      let detail = updatePerson(person.id, root, {
        cards: [
          { id: 'card-a', name: '客服卡', tags: ['客服'], content: '你是客服。' },
          { id: 'card-b', name: '日志卡', tags: ['日志'], content: '你是日志助手。' },
        ],
        currentCardId: 'card-a',
      })
      assert.equal(detail.config.currentCardId, 'card-a')
      let agents = fs.readFileSync(path.join(person.defaultWorkspace, 'AGENTS.md'), 'utf8')
      assert.match(agents, /客服卡/)
      assert.doesNotMatch(agents, /日志卡/)

      detail = updatePerson(person.id, root, { currentCardId: 'card-b' })
      assert.equal(detail.config.currentCardId, 'card-b')
      agents = fs.readFileSync(path.join(person.defaultWorkspace, 'AGENTS.md'), 'utf8')
      assert.match(agents, /日志卡/)
      assert.doesNotMatch(agents, /客服卡/)
    })
  })

  test('旧角色卡的职责 / 工作原则会自动迁移为小节', () => {
    withRoot((root) => {
      const person = createPerson(root, { name: '旧卡迁移' })
      const detail = updatePerson(person.id, root, {
        cards: [
          {
            id: 'card-old',
            name: '旧卡',
            tags: [],
            content: '你是旧卡。\n职责是：完成测试。\n\n工作原则：\n- 认真。',
          },
        ],
      })
      assert.equal(
        detail.cards[0]!.content,
        '你是旧卡。\n\n【职责】\n完成测试。\n\n【工作原则】\n- 认真。',
      )
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

  test('类型交付要求会保存并写入 AGENTS.md', () => {
    withRoot((root) => {
      saveTypes(root, [
        {
          id: 'obs',
          name: '观测性助手',
          delivery: {
            dir: 'reports',
            artifactKinds: ['markdown'],
            required: true,
            naming: '{date}_{app}_{platform}_{report}.md',
          },
        },
      ])
      const person = createPerson(root, { name: '报表助手', typeId: 'obs' })
      const types = loadTypes(root)
      assert.deepEqual(types[0]?.delivery, {
        dir: 'reports',
        artifactKinds: ['markdown'],
        required: true,
        naming: '{date}_{app}_{platform}_{report}.md',
      })

      const agents = fs.readFileSync(path.join(person.defaultWorkspace, 'AGENTS.md'), 'utf8')
      assert.match(agents, /## 交付要求/)
      assert.match(agents, /产物目录：reports/)
      assert.match(agents, /允许的产物类型：markdown/)
      assert.match(agents, /是否必需：是/)
      assert.match(agents, /\{date\}_\{app\}_\{platform\}_\{report\}\.md/)
    })
  })

  test('交付目录必须是工作区内的相对路径', () => {
    withRoot((root) => {
      const types = saveTypes(root, [
        {
          id: 'bad',
          name: '非法交付',
          delivery: {
            dir: '../outside',
            artifactKinds: ['markdown'],
            required: true,
          },
        },
      ])
      assert.equal(types[0]?.delivery?.dir, '')
      assert.equal(types[0]?.delivery?.required, false)
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

  test('启动指令保持简短，角色卡 / 规范 / 任务 / 续接协议都在 AGENTS.md', () => {
    withRoot((root) => {
      const person = createPerson(root, { name: '小蓝' })
      updatePerson(person.id, root, {
        task: '完成日报',
        cards: [
          {
            id: 'c1',
            name: '日报助手',
            tags: ['日报'],
            content: '你是日报助手。职责是写日报。',
          },
        ],
        norms: '- 先读文件再写',
      })
      const agents = fs.readFileSync(path.join(person.defaultWorkspace, 'AGENTS.md'), 'utf8')
      assert.match(agents, /日报助手/)
      assert.match(agents, /先读文件再写/)
      assert.match(agents, /完成日报/)
      assert.match(agents, /STATE\.md/)
      assert.match(agents, /memory\/MEMORY\.md/)
      assert.match(agents, /## 任务看板（目录即状态，唯一真源）/)
      assert.match(agents, /TASKBOARD/)
      assert.match(agents, /## 并行规则/)
      assert.match(agents, /主会话是唯一看板写者/)
      assert.equal(PERSON_STARTUP_PROMPT, '读取 AGENTS.md，然后完成里面的事项。')
    })
  })
})

describe('任务看板', () => {
  const BOARD_STATUSES = ['pending', 'running', 'completed', 'failed', 'stopped'] as const

  /** 看板中按 taskId 找任务文件（文件名 = <seq>_<taskId>.md） */
  function boardTaskFile(workspace: string, taskId: string): { status: string; file: string } {
    for (const status of BOARD_STATUSES) {
      const dir = path.join(workspace, 'TASKBOARD', status)
      if (!fs.existsSync(dir)) continue
      const entry = fs
        .readdirSync(dir)
        .find((name) => name.endsWith(`_${taskId}.md`) && !name.endsWith('.result.md'))
      if (entry) return { status, file: path.join(dir, entry) }
    }
    throw new Error(`看板中找不到任务：${taskId}`)
  }

  function settleTask(
    workspace: string,
    taskId: string,
    status: 'completed' | 'failed' | 'stopped',
    patch: { result?: string; error?: string; artifacts?: unknown[] } = {},
  ): void {
    const found = boardTaskFile(workspace, taskId)
    const target = path.join(workspace, 'TASKBOARD', status, path.basename(found.file))
    fs.renameSync(found.file, target)
    const base = target.slice(0, -3)
    if (patch.result) fs.writeFileSync(`${base}.result.md`, `${patch.result}\n`, 'utf8')
    if (patch.error) fs.writeFileSync(`${base}.error.txt`, `${patch.error}\n`, 'utf8')
    if (patch.artifacts) {
      fs.writeFileSync(`${base}.artifacts.json`, JSON.stringify(patch.artifacts, null, 2), 'utf8')
    }
  }

  test('任务只入列，可调整待执行顺序、删除与重试', () => {
    withRoot((root) => {
      const person = createPerson(root, { name: '任务看板测试' })
      let detail = addPersonTask(person.id, root, { title: '任务 A', content: '执行 A' })
      detail = addPersonTask(person.id, root, { title: '任务 B', content: '执行 B' })
      detail = addPersonTask(person.id, root, { title: '任务 C', content: '执行 C' })
      assert.deepEqual(
        detail.tasks.map((task) => task.title),
        ['任务 A', '任务 B', '任务 C'],
      )
      assert.ok(detail.tasks.every((task) => task.status === 'pending'))

      detail = movePersonTask(person.id, root, detail.tasks[2]!.id, 'up')
      assert.deepEqual(
        detail.tasks.map((task) => task.title),
        ['任务 A', '任务 C', '任务 B'],
      )

      detail = deletePersonTask(person.id, root, detail.tasks[1]!.id)
      assert.deepEqual(
        detail.tasks.map((task) => task.title),
        ['任务 A', '任务 B'],
      )

      const taskA = detail.tasks.find((task) => task.title === '任务 A')!
      settleTask(person.defaultWorkspace, taskA.id, 'failed', { error: '模拟失败' })
      detail = retryPersonTask(person.id, root, taskA.id)
      assert.equal(detail.tasks.find((task) => task.id === taskA.id)?.status, 'pending')
    })
  })

  test('没有待执行任务时启动队列会被拒绝', async () => {
    await withRootAsync(async (root) => {
      const person = createPerson(root, { name: '空队列测试' })
      await assert.rejects(
        () => runPerson(person.id, root),
        (err: unknown) => err instanceof FsError && err.status === 400,
      )
    })
  })

  test('任务产物按相对路径登记，并可读取 Markdown 报表', () => {
    withRoot((root) => {
      const person = createPerson(root, { name: '报表测试' })
      const detail = addPersonTask(person.id, root, {
        title: '查询错误报表',
        content: '查询错误报表',
      })
      const taskId = detail.tasks[0]!.id
      const reportRel = 'reports/2026-11-10_测试_Android_错误报表.md'
      const reportFile = path.join(person.defaultWorkspace, reportRel)
      fs.mkdirSync(path.dirname(reportFile), { recursive: true })
      fs.writeFileSync(reportFile, '# 错误报表\n\n- 错误数：9\n', 'utf8')

      settleTask(person.defaultWorkspace, taskId, 'completed', {
        result: `报表：${reportRel}`,
        artifacts: [{ path: reportRel, kind: 'markdown', title: '错误报表' }],
      })

      const task = getPerson(person.id, root).tasks.find((item) => item.id === taskId)
      assert.deepEqual(task?.artifacts, [
        { path: reportRel, kind: 'markdown', title: '错误报表' },
      ])
      const report = getPersonTaskReport(person.id, root, taskId)
      assert.equal(report.path, reportRel)
      assert.equal(report.title, '错误报表')
      assert.match(report.content, /错误数：9/)
    })
  })

  test('任务没有登记产物时不回退读取 result', () => {
    withRoot((root) => {
      const person = createPerson(root, { name: '无产物测试' })
      const detail = addPersonTask(person.id, root, {
        title: '普通任务',
        content: '普通任务',
      })
      const taskId = detail.tasks[0]!.id
      settleTask(person.defaultWorkspace, taskId, 'completed', { result: '完成，但没有报表文件' })

      assert.equal(getPerson(person.id, root).tasks[0]?.artifacts, undefined)
      assert.throws(
        () => getPersonTaskReport(person.id, root, taskId),
        (err: unknown) => err instanceof FsError && err.status === 404,
      )
    })
  })

  test('看板目录即状态：外部 mv / sidecar 写入后详情立即反映', () => {
    withRoot((root) => {
      const person = createPerson(root, { name: '看板状态测试' })
      const detail = addPersonTask(person.id, root, { title: '执行中任务', content: '干活' })
      const taskId = detail.tasks[0]!.id
      const found = boardTaskFile(person.defaultWorkspace, taskId)
      const running = path.join(person.defaultWorkspace, 'TASKBOARD', 'running', path.basename(found.file))
      fs.renameSync(found.file, running)

      let task = getPerson(person.id, root).tasks.find((item) => item.id === taskId)
      assert.equal(task?.status, 'running')

      const base = running.slice(0, -3)
      fs.writeFileSync(`${base}.result.md`, '执行完成\n', 'utf8')
      const completed = path.join(person.defaultWorkspace, 'TASKBOARD', 'completed', path.basename(running))
      fs.renameSync(running, completed)
      task = getPerson(person.id, root).tasks.find((item) => item.id === taskId)
      assert.equal(task?.status, 'completed')
      assert.equal(task?.result, '执行完成')
    })
  })

  test('旧 tasks.json + TASKS.json 在首次读取时迁移为看板', () => {
    withRoot((root) => {
      const person = createPerson(root, { name: '迁移测试' })
      fs.rmSync(path.join(person.defaultWorkspace, 'TASKBOARD'), { recursive: true, force: true })

      const tasksFile = path.join(person.defaultWorkspace, '.person', 'tasks.json')
      fs.writeFileSync(
        tasksFile,
        JSON.stringify(
          [
            {
              id: 'task_legacy_1',
              title: '旧任务一',
              content: '旧任务一内容',
              status: 'pending',
              createdAt: 1000,
            },
            {
              id: 'task_legacy_2',
              title: '旧任务二',
              content: '旧任务二内容',
              status: 'pending',
              createdAt: 2000,
            },
          ],
          null,
          2,
        ),
        'utf8',
      )
      fs.writeFileSync(
        path.join(person.defaultWorkspace, 'TASKS.json'),
        JSON.stringify({
          queueId: 'queue_legacy',
          tasks: [
            {
              id: 'task_legacy_1',
              status: 'completed',
              result: '镜像里的完成结果',
              artifacts: [],
            },
          ],
        }),
        'utf8',
      )

      const detail = getPerson(person.id, root)
      const first = detail.tasks.find((task) => task.id === 'task_legacy_1')
      const second = detail.tasks.find((task) => task.id === 'task_legacy_2')
      assert.equal(first?.status, 'completed')
      assert.equal(first?.result, '镜像里的完成结果')
      assert.equal(second?.status, 'pending')
      assert.ok(fs.existsSync(path.join(person.defaultWorkspace, 'TASKBOARD', 'completed')))
      assert.ok(fs.existsSync(path.join(person.defaultWorkspace, 'TASKBOARD', 'pending')))
      assert.equal(fs.existsSync(tasksFile), false, '旧 tasks.json 已改名为 .migrated')
      assert.ok(fs.existsSync(`${tasksFile}.migrated`))
      assert.equal(fs.existsSync(path.join(person.defaultWorkspace, 'TASKS.json')), false)
    })
  })

  test('看板目录已存在但为空时，旧 tasks.json 仍会迁移', () => {
    withRoot((root) => {
      const person = createPerson(root, { name: '空看板迁移测试' })
      // 模拟旧版本人员：看板目录已建但从未迁移过，且没有迁移标记
      fs.rmSync(path.join(person.defaultWorkspace, '.person', 'board-migrated.json'), {
        force: true,
      })
      const tasksFile = path.join(person.defaultWorkspace, '.person', 'tasks.json')
      fs.writeFileSync(
        tasksFile,
        JSON.stringify([
          {
            id: 'task_empty_board',
            title: '空看板旧任务',
            content: '看板目录已存在也要迁移',
            status: 'pending',
            createdAt: 1000,
          },
        ]),
        'utf8',
      )

      const detail = getPerson(person.id, root)
      const task = detail.tasks.find((item) => item.id === 'task_empty_board')
      assert.equal(task?.status, 'pending')
      assert.equal(fs.existsSync(tasksFile), false)
      assert.ok(fs.existsSync(`${tasksFile}.migrated`))
      const pending = fs.readdirSync(
        path.join(person.defaultWorkspace, 'TASKBOARD', 'pending'),
      )
      assert.ok(pending.some((name) => name.endsWith('.md')))
    })
  })

  test('并行数钳制在 1..8', () => {
    withRoot((root) => {
      const person = createPerson(root, { name: '并行数测试' })
      assert.equal(person.config.parallelism, 1)
      assert.equal(updatePerson(person.id, root, { parallelism: 99 }).config.parallelism, 8)
      assert.equal(updatePerson(person.id, root, { parallelism: 0 }).config.parallelism, 1)
    })
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
