/** 人员看板后台刷新：动态字段更新，编辑草稿保留。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PersonDetail } from '@/shared/personnel'
import { mergePersonBoardSnapshot } from './board-sync'

test('mergePersonBoardSnapshot：任务 / 队列更新，角色卡 / 规范 / 配置草稿保留', () => {
  const prev = {
    id: 'p1',
    name: '本地名字',
    cards: [{ id: 'draft-card', name: '未保存卡片' }],
    norms: '未保存规范',
    config: { model: { model: 'draft-model' } },
    memory: { text: '旧记忆', files: [], count: 0 },
    tasks: [],
    activity: [],
    stats: { runs: 0, completed: 0, failed: 0 },
    run: { status: 'idle' },
    queue: { status: 'idle', completed: 0, failed: 0, total: 0 },
    taskCounts: { pending: 0, running: 0, completed: 0, failed: 0, stopped: 0, total: 0 },
  } as unknown as PersonDetail
  const next = {
    id: 'p1',
    name: '服务端名字',
    cards: [{ id: 'server-card', name: '服务端卡片' }],
    norms: '服务端规范',
    config: { model: { model: 'server-model' } },
    memory: { text: '新记忆', files: [{ name: 'MEMORY.md', size: 10, preview: 'x' }], count: 1 },
    tasks: [{ id: 't1', title: '蓝图任务', status: 'pending', content: '干活' }],
    activity: [{ id: 'a1', type: 'task_added', text: '添加任务', ts: 1 }],
    stats: { runs: 1, completed: 0, failed: 0 },
    run: { status: 'idle' },
    queue: { status: 'running', completed: 0, failed: 0, total: 1 },
    taskCounts: { pending: 1, running: 0, completed: 0, failed: 0, stopped: 0, total: 1 },
    memoryCount: 1,
    roleCardCount: 1,
  } as unknown as PersonDetail

  const merged = mergePersonBoardSnapshot(prev, next)
  assert.equal(merged.cards, prev.cards, '角色卡草稿保持原引用')
  assert.equal(merged.norms, '未保存规范')
  assert.equal(merged.config, prev.config)
  assert.equal(merged.name, '本地名字')
  assert.equal(merged.tasks, next.tasks)
  assert.equal(merged.queue.status, 'running')
  assert.equal(merged.taskCounts.pending, 1)
  assert.equal(merged.memory.text, '新记忆')
})
