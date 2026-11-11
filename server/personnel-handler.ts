/**
 * personnel 插件 invoke 处理器（蓝图人员任务节点 → 人员模块）
 *
 * 设计边界：蓝图只派发任务 / 接收事件，不直接改人员配置、不裸开 DSH 会话。
 * 任务写入人员 TASKBOARD/pending/，执行与交付由人员队列负责。
 */
import type { InvokePayload } from './plugins/executor'
import { addPersonTask, getPerson, listPeople, resolvePeopleRoot, runPerson } from './personnel'
import { taskTitleFromContent } from './person-board'
import type { PersonTask, PersonTaskSource } from '../src/shared/personnel'

/** 等待人员任务终态的轮询间隔（看板目录即状态，读写都很轻） */
const WAIT_POLL_MS = 500
const TERMINAL_STATUSES = new Set<PersonTask['status']>(['completed', 'failed', 'stopped'])

function strArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 按 id 或精确名字解析人员；找不到返回 null */
function resolvePersonRef(ref: string, root: string): { id: string; name: string } | null {
  const people = listPeople(root)
  return (
    people.find((person) => person.id === ref) ??
    people.find((person) => person.name === ref) ??
    null
  )
}

function abortError(): Error {
  const error = new Error('等待任务完成已取消')
  error.name = 'AbortError'
  return error
}

/** 可中止的等待（蓝图停止运行时通过 HTTP 断连中止服务端轮询） */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function taskOf(personId: string, root: string, taskId: string): PersonTask | null {
  return getPerson(personId, root).tasks.find((task) => task.id === taskId) ?? null
}

async function waitForTask(
  personId: string,
  root: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<PersonTask> {
  while (true) {
    if (signal?.aborted) throw abortError()
    const task = taskOf(personId, root, taskId)
    if (!task) throw new Error('等待期间任务已不存在（可能已被删除）')
    if (TERMINAL_STATUSES.has(task.status)) return task
    await sleep(WAIT_POLL_MS, signal)
  }
}

/** 等待结束后的「结果说明」：完成取交付结果，失败 / 中断取错误原因 */
function taskResultMessage(task: PersonTask): string {
  const detail = (task.result || task.error || '').trim().slice(0, 4_000)
  const title = task.title || '任务'
  if (task.status === 'completed') {
    return detail ? `任务完成：${title}\n${detail}` : `任务完成：${title}`
  }
  if (task.status === 'stopped') {
    return detail ? `任务已中断：${title}\n${detail}` : `任务已中断：${title}`
  }
  return detail ? `任务失败：${title}\n${detail}` : `任务失败：${title}`
}

/**
 * 运行内幂等查找：同一 runId + 节点 + 人员，且标题 / 内容一致时复用已有任务。
 * 标题或内容变化视为有意的新派发；runId 缺失时按每次调用新建处理。
 */
function findExistingTaskId(
  personId: string,
  root: string,
  source: PersonTaskSource,
  title: string,
  content: string,
): string | null {
  if (!source.runId || !source.nodeId) return null
  const detail = getPerson(personId, root)
  const found = detail.tasks.find(
    (task) =>
      task.source?.runId === source.runId &&
      task.source?.nodeId === source.nodeId &&
      task.content === content &&
      (!title || task.title === title),
  )
  return found?.id ?? null
}

export async function invokePersonnelNode(
  node: string,
  args: Record<string, unknown>,
  deps: { project: string; signal?: AbortSignal },
): Promise<InvokePayload> {
  const root = resolvePeopleRoot()
  try {
    if (node.endsWith('.taskEvent')) {
      // 事件节点由 WS 推送驱动；这里只回显事件参数，避免 invoke 降级报错
      return {
        ok: true,
        outputs: {
          personId: strArg(args.personId),
          taskId: strArg(args.taskId),
          status: strArg(args.status),
          result: typeof args.result === 'string' ? args.result : '',
          error: typeof args.error === 'string' ? args.error : '',
          artifacts: typeof args.artifacts === 'string' ? args.artifacts : JSON.stringify(args.artifacts ?? []),
          source: typeof args.source === 'string' ? args.source : JSON.stringify(args.source ?? {}),
        },
      }
    }

    if (node.endsWith('.dispatch')) {
      const content = strArg(args.content)
      if (!content) return { ok: false, message: '任务内容不能为空（填写「任务内容」或连线）' }
      const ref = strArg(args.personId)
      if (!ref) return { ok: false, message: '请指定一位人员' }
      const person = resolvePersonRef(ref, root)
      if (!person) return { ok: false, message: `未找到人员：${ref}` }
      const title = strArg(args.title) || taskTitleFromContent(content)
      const autoRun = args.autoRun !== false
      const waitForCompletion = args.waitForCompletion !== false

      const source: PersonTaskSource = {
        kind: 'blueprint',
        ...(deps.project ? { project: deps.project } : {}),
        ...(strArg(args.__assetPath) ? { assetPath: strArg(args.__assetPath) } : {}),
        ...(strArg(args.__nodeId) ? { nodeId: strArg(args.__nodeId) } : {}),
        ...(strArg(args.__runId) ? { runId: strArg(args.__runId) } : {}),
      }

      const existing = findExistingTaskId(person.id, root, source, title, content)
      const existingTask = existing ? taskOf(person.id, root, existing) : null
      if (existingTask && TERMINAL_STATUSES.has(existingTask.status)) {
        return {
          ok: true,
          outputs: {
            ok: true,
            personId: person.id,
            personName: person.name,
            taskId: existing,
            message: `复用了本轮已派发任务；${taskResultMessage(existingTask)}`,
          },
        }
      }
      // 新任务 / 仍在 pending 的任务没有“立即执行”就不会动，等待会永久挂起；
      // 已在 running 的复用任务允许只等待，不再要求重新启动队列。
      if (waitForCompletion && !autoRun && (!existingTask || existingTask.status === 'pending')) {
        return {
          ok: false,
          message: '已勾选「等待完成通知」时，待执行任务必须同时勾选「立即执行」，否则任务不会启动',
        }
      }

      let taskId = existing ?? ''
      if (!taskId) {
        const before = new Set(getPerson(person.id, root).tasks.map((task) => task.id))
        addPersonTask(person.id, root, { title, content, source })
        taskId = getPerson(person.id, root).tasks.find((task) => !before.has(task.id))?.id ?? ''
        if (!taskId) return { ok: false, message: '任务写入看板失败' }
      }

      const dispatched = taskOf(person.id, root, taskId)
      if (!dispatched) return { ok: false, message: '任务写入看板后无法回读' }
      if (autoRun && dispatched.status === 'pending') {
        await runPerson(person.id, root).catch((err: unknown) => {
          // 人员已在执行中：任务留在 pending/，由运行中的会话按协议继续领取
          // （竞态下任务刚被领取走时，runPerson 可能报“没有待执行的任务”，同样不阻断等待）
          if (
            err instanceof Error &&
            (err.message.includes('正在执行') || err.message.includes('没有待执行的任务'))
          ) {
            return
          }
          throw err
        })
      }
      const reusedPrefix = existing ? '复用了本轮已派发任务；' : ''
      if (!waitForCompletion) {
        return {
          ok: true,
          outputs: {
            ok: true,
            personId: person.id,
            personName: person.name,
            taskId,
            message: `${reusedPrefix}已派发给：${person.name}`,
          },
        }
      }
      const finished = await waitForTask(person.id, root, taskId, deps.signal)
      return {
        ok: true,
        outputs: {
          ok: true,
          personId: person.id,
          personName: person.name,
          taskId,
          message: `${reusedPrefix}${taskResultMessage(finished)}`,
        },
      }
    }

    return { ok: false, message: `personnel 插件未实现节点「${node}」的服务端执行器` }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, message: '等待任务完成已取消' }
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
