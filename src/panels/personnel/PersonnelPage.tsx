/**
 * 「人员」页面：左侧人员列表 + 右侧人员编辑。
 *
 * 页面常驻挂载（侧栏切换只改 display），可见时订阅看板变化并轮询执行状态；
 * 执行状态从人员列表接口读取，详情只合并任务 / 队列等动态字段，
 * 避免后台刷新覆盖正在编辑的角色卡 / 规范 / 设置草稿。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { UserRound, Users } from 'lucide-react'
import { toast } from 'sonner'
import type { PersonDetail, PersonSummary, PersonType } from '@/shared/personnel'
import { sharedDebugWs } from '@/shell/debug/debug-ws'
import { Icon } from '@/shell/ui/Icon'
import { useWorkspaceStore } from '@/shell/workspace-store'
import { PersonnelApiError, personnelApi } from './api'
import { mergePersonBoardSnapshot } from './board-sync'
import { PersonCreateDialog } from './PersonCreateDialog'
import { PersonEditor } from './PersonEditor'
import { PersonList } from './PersonList'
import { TypeManagerDialog } from './TypeManagerDialog'
import { ConfirmDialog } from './primitives'
import './personnel.css'

interface PersonnelPageProps {
  active: boolean
}

const SELECTED_KEY = 'bps.personnel.selected'
const GROUP_KEY = 'bps.personnel.groupByType'

function readGroupByType(): boolean {
  try {
    return localStorage.getItem(GROUP_KEY) === '1'
  } catch {
    return false
  }
}

function readSelected(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY)
  } catch {
    return null
  }
}

export function PersonnelPage({ active }: PersonnelPageProps) {
  const [people, setPeople] = useState<PersonSummary[]>([])
  const [types, setTypes] = useState<PersonType[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(readSelected)
  const [detail, setDetail] = useState<PersonDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [groupByType, setGroupByType] = useState(readGroupByType)
  const [createOpen, setCreateOpen] = useState(false)
  const [typesOpen, setTypesOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<PersonSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const selectedRef = useRef<string | null>(selectedId)
  const peopleRef = useRef<PersonSummary[]>([])
  const detailRequest = useRef(0)
  const boardRefreshTimer = useRef<number | null>(null)
  const wasActiveRef = useRef(active)
  const project = useWorkspaceStore((s) => s.currentProject?.name ?? null)

  useEffect(() => {
    selectedRef.current = selectedId
    try {
      if (selectedId) localStorage.setItem(SELECTED_KEY, selectedId)
      else localStorage.removeItem(SELECTED_KEY)
    } catch {
      /* localStorage 不可用 */
    }
  }, [selectedId])

  useEffect(() => {
    peopleRef.current = people
  }, [people])

  const loadDetail = useCallback(async (
    id: string,
    opts: { preserveEditors?: boolean } = {},
  ): Promise<void> => {
    const seq = ++detailRequest.current
    setDetailLoading(true)
    try {
      const payload = await personnelApi.get(id)
      if (detailRequest.current === seq) {
        const person = payload.person
        setDetail((prev) =>
          opts.preserveEditors && prev && prev.id === person.id
            ? mergePersonBoardSnapshot(prev, person)
            : person,
        )
      }
    } catch (err) {
      if (detailRequest.current === seq) {
        setDetail(null)
        if (err instanceof PersonnelApiError && err.status === 404) {
          selectedRef.current = null
          setSelectedId(null)
        } else {
          toast.error(err instanceof Error ? err.message : '加载人员详情失败')
        }
      }
    } finally {
      if (detailRequest.current === seq) setDetailLoading(false)
    }
  }, [])

  const applyList = useCallback(
    (list: PersonSummary[], nextTypes: PersonType[]): string | null => {
      setPeople(list)
      setTypes(nextTypes)
      peopleRef.current = list
      const current = selectedRef.current
      const next = current && list.some((p) => p.id === current) ? current : (list[0]?.id ?? null)
      if (next !== current) {
        selectedRef.current = next
        setSelectedId(next)
      }
      return next
    },
    [],
  )

  const refreshAll = useCallback(async (): Promise<void> => {
    try {
      const payload = await personnelApi.list()
      const next = applyList(payload.people, payload.types)
      if (next) await loadDetail(next)
      else setDetail(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载人员列表失败')
    } finally {
      setLoading(false)
    }
  }, [applyList, loadDetail])

  /** 看板事件刷新：更新列表 + 仅替换详情中的动态字段，不覆盖编辑草稿 */
  const refreshBoard = useCallback(async (): Promise<void> => {
    try {
      const payload = await personnelApi.list()
      const next = applyList(payload.people, payload.types)
      if (next) await loadDetail(next, { preserveEditors: true })
      else setDetail(null)
    } catch {
      /* 后台刷新失败静默：下次事件或切回人员页继续 */
    }
  }, [applyList, loadDetail])

  const scheduleBoardRefresh = useCallback((): void => {
    if (boardRefreshTimer.current !== null) return
    boardRefreshTimer.current = window.setTimeout(() => {
      boardRefreshTimer.current = null
      void refreshBoard()
    }, 120)
  }, [refreshBoard])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  /* 从其它页面切回人员页：立即同步一次看板（保留未保存编辑） */
  useEffect(() => {
    const becameActive = active && !wasActiveRef.current
    wasActiveRef.current = active
    if (becameActive) void refreshBoard()
  }, [active, refreshBoard])

  /* 实时看板：订阅当前项目的 plugin 频道，蓝图派发 / 队列状态变化即时刷新 */
  useEffect(() => {
    if (!active || !project) return
    const ws = sharedDebugWs()
    const subscribe = (): void => {
      ws.send({ type: 'plugin.subscribe', project })
    }
    const unsubscribeWs = ws.addListener({
      onOpen: subscribe,
      onMessage: (msg) => {
        if (msg.type !== 'personnel.boardChanged') return
        scheduleBoardRefresh()
      },
    })
    subscribe()
    return () => {
      unsubscribeWs()
      ws.send({ type: 'plugin.unsubscribe', project })
    }
  }, [active, project, scheduleBoardRefresh])

  useEffect(() => {
    return () => {
      if (boardRefreshTimer.current !== null) {
        window.clearTimeout(boardRefreshTimer.current)
        boardRefreshTimer.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (loading) return
    if (!selectedId) {
      setDetail(null)
      return
    }
    if (detail?.id === selectedId) return
    void loadDetail(selectedId)
  }, [loading, selectedId, detail?.id, loadDetail])

  useEffect(() => {
    if (!active) return
    const anyRunning = people.some(
      (p) => p.queue.status === 'running' || p.queue.status === 'stopping',
    )
    if (!anyRunning) return
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const payload = await personnelApi.list()
          const previous = new Map(peopleRef.current.map((p) => [p.id, p]))
          applyList(payload.people, payload.types)
          const currentId = selectedRef.current
          const current = payload.people.find((p) => p.id === currentId)
          const before = currentId ? previous.get(currentId) : undefined
          const wasRunning =
            before?.queue.status === 'running' || before?.queue.status === 'stopping'
          const nowRunning =
            current?.queue.status === 'running' || current?.queue.status === 'stopping'
          if (currentId && (wasRunning || nowRunning)) {
            await loadDetail(currentId, { preserveEditors: true })
          }
        } catch {
          /* 轮询失败静默：下次继续 */
        }
      })()
    }, 1600)
    return () => window.clearInterval(timer)
  }, [active, people, applyList, loadDetail])

  const selected = useMemo(
    () => people.find((p) => p.id === selectedId) ?? null,
    [people, selectedId],
  )
  const anyRunning = people.some(
    (p) => p.queue.status === 'running' || p.queue.status === 'stopping',
  )

  const selectPerson = (id: string): void => {
    if (id === selectedId) return
    setSelectedId(id)
    setDetail(null)
  }

  const createPerson = async (name: string, typeId: string): Promise<void> => {
    const payload = await personnelApi.create({ name, typeId })
    setCreateOpen(false)
    selectedRef.current = payload.person.id
    setSelectedId(payload.person.id)
    setDetail(payload.person)
    await refreshAll()
    toast.success(`已创建「${name}」，默认工作区已生成`)
  }

  const saveTypes = async (next: PersonType[]): Promise<void> => {
    await personnelApi.saveTypes(next)
    setTypesOpen(false)
    await refreshAll()
    toast.success('人员类型已保存')
  }

  const removePerson = async (): Promise<void> => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await personnelApi.remove(deleteTarget.id)
      if (selectedId === deleteTarget.id) {
        selectedRef.current = null
        setSelectedId(null)
        setDetail(null)
      }
      setDeleteTarget(null)
      await refreshAll()
      toast.success(`已删除「${deleteTarget.name}」`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除人员失败')
    } finally {
      setDeleting(false)
    }
  }

  const setGrouping = (value: boolean): void => {
    setGroupByType(value)
    try {
      localStorage.setItem(GROUP_KEY, value ? '1' : '0')
    } catch {
      /* localStorage 不可用 */
    }
  }

  return (
    <div className="pp-root">
      <div className="pp-shell">
        <PersonList
          people={people}
          types={types}
          selectedId={selectedId}
          loading={loading}
          query={query}
          onQueryChange={setQuery}
          groupByType={groupByType}
          onGroupByTypeChange={setGrouping}
          onSelect={selectPerson}
          onAdd={() => setCreateOpen(true)}
          onDelete={setDeleteTarget}
          onEditTypes={() => setTypesOpen(true)}
          busy={anyRunning}
        />

        <section className="pp-main">
          {selected && detail && detail.id === selected.id ? (
            <PersonEditor
              key={selected.id}
              person={selected}
              detail={detail}
              types={types}
              onRefresh={refreshAll}
              onEditTypes={() => setTypesOpen(true)}
            />
          ) : (
            <div className="pp-blank">
              <div className="pp-blank-icon">
                <Icon icon={detailLoading ? Users : UserRound} size={34} />
              </div>
              <h2>{detailLoading ? '加载中…' : people.length === 0 ? '还没有人员' : '选择一位人员'}</h2>
              <p>
                {people.length === 0
                  ? '新建人员后会自动生成默认工作区，头像、角色卡、规范、记忆与设置都保存在里面。'
                  : '从左侧列表选择一位人员，开始编辑人设、模型与工作区。'}
              </p>
              {people.length === 0 ? (
                <button type="button" className="pp-btn primary" onClick={() => setCreateOpen(true)}>
                  新建人员
                </button>
              ) : null}
            </div>
          )}
        </section>
      </div>

      {createOpen ? (
        <PersonCreateDialog
          types={types}
          onClose={() => setCreateOpen(false)}
          onCreate={createPerson}
        />
      ) : null}
      {typesOpen ? (
        <TypeManagerDialog
          types={types}
          people={people}
          groupByType={groupByType}
          onGroupByTypeChange={setGrouping}
          onSave={saveTypes}
          onClose={() => setTypesOpen(false)}
        />
      ) : null}
      {deleteTarget ? (
        <ConfirmDialog
          title="删除人员"
          message={`确定删除「${deleteTarget.name}」吗？默认工作区会一起删除；如果设置了外部工作区目录，外部目录不会被删除。`}
          confirmLabel="删除人员"
          danger
          busy={deleting}
          onConfirm={() => void removePerson()}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}
    </div>
  )
}
