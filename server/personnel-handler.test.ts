/** personnel 插件处理器单测：派发写入看板、运行内幂等、内容变化新建、来源溯源、事件回显。 */
import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WebSocket } from 'ws'
import { createPerson, getPerson } from './personnel'
import { invokePersonnelNode } from './personnel-handler'
import { agentGateway } from './agents/handler'
import { pluginPushHub } from './plugins/executor'

after(() => {
  agentGateway.dispose()
})

function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-personnel-plugin-'))
  const previous = process.env.BP_PEOPLE_ROOT
  process.env.BP_PEOPLE_ROOT = root
  return fn(root).finally(() => {
    if (previous === undefined) delete process.env.BP_PEOPLE_ROOT
    else process.env.BP_PEOPLE_ROOT = previous
    fs.rmSync(root, { recursive: true, force: true })
  })
}

describe('personnel 插件处理器', () => {
  /** 把 pending 任务直接推进到 completed，并写结果 sidecar（模拟人员执行完成） */
  function completePendingTask(workspace: string, taskId: string, result: string): void {
    const pending = path.join(workspace, 'TASKBOARD', 'pending')
    const name = fs.readdirSync(pending).find((item) => item.endsWith(`_${taskId}.md`))
    assert.ok(name, `pending 中应存在任务 ${taskId}`)
    const completed = path.join(workspace, 'TASKBOARD', 'completed')
    fs.renameSync(path.join(pending, name), path.join(completed, name))
    fs.writeFileSync(path.join(completed, name.replace(/\.md$/, '.result.md')), result)
  }

  test('派发写入 pending 并记录蓝图来源；同 run 重复触发复用任务', async () => {
    await withRoot(async () => {
      const person = createPerson(process.env.BP_PEOPLE_ROOT!, { name: '派发测试' })
      const args = {
        personId: person.id,
        title: '蓝图任务',
        content: '执行蓝图派发的任务',
        autoRun: false,
        waitForCompletion: false,
        __runId: 'run-test-1',
        __nodeId: 'dispatch-1',
        __assetPath: 'blueprint/main.bp.json',
      }
      const first = await invokePersonnelNode('personnel.dispatch', args, { project: 'Demo' })
      assert.equal(first.ok, true)
      const firstTaskId = first.outputs?.taskId as string
      assert.ok(firstTaskId)
      assert.equal(first.outputs?.personId, person.id)
      assert.equal(first.outputs?.personName, '派发测试')
      assert.match(String(first.outputs?.message), /已派发给/)

      const detail = getPerson(person.id, process.env.BP_PEOPLE_ROOT!)
      const task = detail.tasks.find((item) => item.id === firstTaskId)
      assert.equal(task?.status, 'pending')
      assert.equal(task?.source?.runId, 'run-test-1')
      assert.equal(task?.source?.nodeId, 'dispatch-1')
      assert.equal(task?.source?.project, 'Demo')
      assert.equal(task?.source?.assetPath, 'blueprint/main.bp.json')

      const second = await invokePersonnelNode('personnel.dispatch', args, { project: 'Demo' })
      assert.equal(second.outputs?.taskId, firstTaskId, '同一 runId + 节点 + 人员应复用任务')
      assert.match(String(second.outputs?.message), /复用/)
      assert.equal(getPerson(person.id, process.env.BP_PEOPLE_ROOT!).tasks.length, 1)
    })
  })

  test('派发写入看板时广播 personnel.boardChanged（人员页无需刷新）', async () => {
    await withRoot(async () => {
      const person = createPerson(process.env.BP_PEOPLE_ROOT!, { name: '看板广播测试' })
      const messages: Array<Record<string, unknown>> = []
      const fake = {
        readyState: 1,
        send: (raw: string) => messages.push(JSON.parse(raw) as Record<string, unknown>),
        on: () => undefined,
      } as unknown as WebSocket
      const previousIdle = pluginPushHub.idleStopMs
      pluginPushHub.idleStopMs = 0
      pluginPushHub.subscribe(fake, 'Demo')
      try {
        await invokePersonnelNode(
          'personnel.dispatch',
          {
            personId: person.id,
            title: '广播任务',
            content: '立即出现在人员页',
            autoRun: false,
            waitForCompletion: false,
            __runId: 'run-broadcast-1',
            __nodeId: 'dispatch-broadcast',
          },
          { project: 'Demo' },
        )
        const changed = messages.find((msg) => msg.type === 'personnel.boardChanged')
        assert.ok(changed, '应广播看板变化')
        assert.equal(changed.personId, person.id)
        assert.equal(changed.change, 'task_added')
        assert.equal(changed.status, 'pending')
        assert.equal(typeof changed.taskId, 'string')
      } finally {
        pluginPushHub.unsubscribe(fake, 'Demo')
        pluginPushHub.idleStopMs = previousIdle
      }
    })
  })

  test('不同 runId 允许重新派发一轮', async () => {
    await withRoot(async () => {
      const person = createPerson(process.env.BP_PEOPLE_ROOT!, { name: '重跑测试' })
      const base = {
        personId: person.id,
        content: '同一份任务',
        autoRun: false,
        waitForCompletion: false,
        __nodeId: 'dispatch-1',
      }
      const first = await invokePersonnelNode(
        'personnel.dispatch',
        { ...base, __runId: 'run-a' },
        { project: 'Demo' },
      )
      const second = await invokePersonnelNode(
        'personnel.dispatch',
        { ...base, __runId: 'run-b' },
        { project: 'Demo' },
      )
      assert.notEqual(first.outputs?.taskId, second.outputs?.taskId)
      assert.equal(getPerson(person.id, process.env.BP_PEOPLE_ROOT!).tasks.length, 2)
    })
  })

  test('同一 runId + 节点 + 人员：内容变化时创建新任务', async () => {
    await withRoot(async () => {
      const person = createPerson(process.env.BP_PEOPLE_ROOT!, { name: '内容变化测试' })
      const base = {
        personId: person.id,
        title: '同一节点',
        autoRun: false,
        waitForCompletion: false,
        __runId: 'run-content-change',
        __nodeId: 'dispatch-1',
      }
      const first = await invokePersonnelNode(
        'personnel.dispatch',
        { ...base, content: '第一版内容' },
        { project: 'Demo' },
      )
      const second = await invokePersonnelNode(
        'personnel.dispatch',
        { ...base, content: '第二版内容' },
        { project: 'Demo' },
      )
      assert.notEqual(first.outputs?.taskId, second.outputs?.taskId)
      assert.equal(getPerson(person.id, process.env.BP_PEOPLE_ROOT!).tasks.length, 2)
    })
  })

  test('标题留空取任务内容第一行；等待完成通知返回结果说明', async () => {
    await withRoot(async () => {
      const person = createPerson(process.env.BP_PEOPLE_ROOT!, { name: '等待完成测试' })
      const args = {
        personId: person.id,
        title: '',
        content: '首行即标题\n第二行是正文',
        autoRun: false,
        waitForCompletion: false,
        __runId: 'run-wait',
        __nodeId: 'dispatch-wait',
      }
      const dispatched = await invokePersonnelNode('personnel.dispatch', args, { project: 'Demo' })
      assert.equal(dispatched.ok, true)
      const taskId = String(dispatched.outputs?.taskId ?? '')
      const detail = getPerson(person.id, process.env.BP_PEOPLE_ROOT!)
      assert.equal(detail.tasks.find((task) => task.id === taskId)?.title, '首行即标题')

      completePendingTask(person.defaultWorkspace, taskId, '交付物已生成')
      const waited = await invokePersonnelNode(
        'personnel.dispatch',
        { ...args, waitForCompletion: true },
        { project: 'Demo' },
      )
      assert.equal(waited.ok, true)
      assert.match(String(waited.outputs?.message), /任务完成：首行即标题/)
      assert.match(String(waited.outputs?.message), /交付物已生成/)
      assert.equal(waited.outputs?.taskId, taskId, '同一轮复用已有任务')
    })
  })

  test('等待完成通知会轮询运行中的任务，完成后返回结果', async () => {
    await withRoot(async () => {
      const person = createPerson(process.env.BP_PEOPLE_ROOT!, { name: '轮询等待测试' })
      const args = {
        personId: person.id,
        title: '轮询任务',
        content: '等待执行完成',
        autoRun: false,
        waitForCompletion: false,
        __runId: 'run-poll-wait',
        __nodeId: 'dispatch-poll-wait',
      }
      const dispatched = await invokePersonnelNode('personnel.dispatch', args, { project: 'Demo' })
      const taskId = String(dispatched.outputs?.taskId ?? '')
      const board = path.join(person.defaultWorkspace, 'TASKBOARD')
      const pendingName = fs
        .readdirSync(path.join(board, 'pending'))
        .find((item) => item.endsWith(`_${taskId}.md`))
      assert.ok(pendingName)
      fs.renameSync(
        path.join(board, 'pending', pendingName),
        path.join(board, 'running', pendingName),
      )

      setTimeout(() => {
        fs.renameSync(
          path.join(board, 'running', pendingName),
          path.join(board, 'completed', pendingName),
        )
        fs.writeFileSync(
          path.join(board, 'completed', pendingName.replace(/\.md$/, '.result.md')),
          '轮询到完成',
        )
      }, 50)

      const waited = await invokePersonnelNode(
        'personnel.dispatch',
        { ...args, waitForCompletion: true },
        { project: 'Demo' },
      )
      assert.equal(waited.ok, true)
      assert.match(String(waited.outputs?.message), /任务完成：轮询任务/)
      assert.match(String(waited.outputs?.message), /轮询到完成/)
      assert.equal(waited.outputs?.taskId, taskId)
    })
  })

  test('等待完成通知但未立即执行：直接报错，避免永久等待', async () => {
    await withRoot(async () => {
      const person = createPerson(process.env.BP_PEOPLE_ROOT!, { name: '等待校验' })
      const result = await invokePersonnelNode(
        'personnel.dispatch',
        {
          personId: person.id,
          content: '不会启动的任务',
          autoRun: false,
          waitForCompletion: true,
          __runId: 'run-no-start',
          __nodeId: 'dispatch-no-start',
        },
        { project: 'Demo' },
      )
      assert.equal(result.ok, false)
      assert.match(result.message ?? '', /必须同时勾选「立即执行」/)
      assert.equal(getPerson(person.id, process.env.BP_PEOPLE_ROOT!).tasks.length, 0)
    })
  })

  test('exec 分叉的两个单人节点各派一份任务', async () => {
    await withRoot(async () => {
      const first = createPerson(process.env.BP_PEOPLE_ROOT!, { name: '甲' })
      const second = createPerson(process.env.BP_PEOPLE_ROOT!, { name: '乙' })
      const base = {
        title: '分叉任务',
        content: '同一蓝图运行内的两份任务',
        autoRun: false,
        waitForCompletion: false,
        __runId: 'run-fanout',
      }
      const firstResult = await invokePersonnelNode(
        'personnel.dispatch',
        { ...base, personId: first.id, __nodeId: 'dispatch-a' },
        { project: 'Demo' },
      )
      const secondResult = await invokePersonnelNode(
        'personnel.dispatch',
        { ...base, personId: second.id, __nodeId: 'dispatch-b' },
        { project: 'Demo' },
      )
      assert.match(String(firstResult.outputs?.message), /已派发给/)
      assert.match(String(secondResult.outputs?.message), /已派发给/)
      assert.equal(firstResult.outputs?.personId, first.id)
      assert.equal(secondResult.outputs?.personId, second.id)
      assert.notEqual(firstResult.outputs?.taskId, secondResult.outputs?.taskId)

      const root = process.env.BP_PEOPLE_ROOT!
      assert.equal(getPerson(first.id, root).tasks.length, 1)
      assert.equal(getPerson(second.id, root).tasks.length, 1)
    })
  })

  test('未知人员返回 ok:false；事件节点回显参数', async () => {
    await withRoot(async () => {
      const missing = await invokePersonnelNode(
        'personnel.dispatch',
        { personId: '不存在的人', content: '任务', autoRun: false },
        { project: 'Demo' },
      )
      assert.equal(missing.ok, false)
      assert.match(missing.message ?? '', /未找到人员/)

      const echoed = await invokePersonnelNode(
        'personnel.taskEvent',
        {
          personId: 'p1',
          taskId: 'task1',
          status: 'completed',
          result: '完成',
          artifacts: [{ path: 'a.md', kind: 'markdown' }],
        },
        { project: 'Demo' },
      )
      assert.equal(echoed.ok, true)
      assert.equal(echoed.outputs?.status, 'completed')
      assert.equal(echoed.outputs?.result, '完成')
      assert.match(String(echoed.outputs?.artifacts), /a\.md/)
    })
  })
})
