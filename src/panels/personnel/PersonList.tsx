/**
 * 人员列表（左侧栏）：搜索、新增、删除、按类型分组与类型编辑入口。
 */
import { useMemo } from 'react'
import { Plus, Search, Settings2, Trash2 } from 'lucide-react'
import type { PersonSummary, PersonType } from '@/shared/personnel'
import { Icon } from '@/shell/ui/Icon'
import { IconButton } from '@/shell/ui/IconButton'
import { PersonAvatar, PpCheckbox } from './primitives'
import { queueStatusMeta } from './format'

interface PersonListProps {
  people: PersonSummary[]
  types: PersonType[]
  selectedId: string | null
  loading: boolean
  query: string
  onQueryChange: (value: string) => void
  groupByType: boolean
  onGroupByTypeChange: (value: boolean) => void
  onSelect: (id: string) => void
  onAdd: () => void
  onDelete: (person: PersonSummary) => void
  onEditTypes: () => void
  busy: boolean
}

interface PersonGroup {
  id: string
  name: string
  people: PersonSummary[]
}

export function PersonList(props: PersonListProps) {
  const typeName = useMemo(() => {
    const map = new Map(props.types.map((t) => [t.id, t.name]))
    return (id: string): string => map.get(id) ?? '未分类'
  }, [props.types])

  const filtered = useMemo(() => {
    const q = props.query.trim().toLowerCase()
    if (!q) return props.people
    return props.people.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        typeName(p.typeId).toLowerCase().includes(q),
    )
  }, [props.people, props.query, typeName])

  const groups = useMemo<PersonGroup[]>(() => {
    if (!props.groupByType) return [{ id: '', name: '', people: filtered }]
    const map = new Map<string, PersonGroup>()
    for (const type of props.types) map.set(type.id, { id: type.id, name: type.name, people: [] })
    map.set('', { id: '', name: '未分类', people: [] })
    for (const person of filtered) {
      const key = map.has(person.typeId) ? person.typeId : ''
      map.get(key)!.people.push(person)
    }
    return [...map.values()].filter((g) => g.people.length > 0)
  }, [filtered, props.groupByType, props.types])

  const renderRow = (person: PersonSummary) => {
    const meta = queueStatusMeta(person.queue)
    const queueBusy = person.queue.status === 'running' || person.queue.status === 'stopping'
    return (
      <div
        key={person.id}
        className={`pp-person-row${props.selectedId === person.id ? ' active' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => props.onSelect(person.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            props.onSelect(person.id)
          }
        }}
      >
        <PersonAvatar name={person.name} src={person.avatarUrl} size={34} />
        <div className="pp-person-info">
          <div className="pp-person-name">
            <span>{person.name}</span>
            {queueBusy ? (
              <i className={`pp-run-dot ${meta.tone}`} title={meta.label} />
            ) : null}
          </div>
          <div className="pp-person-sub">
            <span>{typeName(person.typeId)}</span>
            {person.taskCounts.total > 0 ? (
              <span>
                · 待执行 {person.taskCounts.pending} / 共 {person.taskCounts.total}
              </span>
            ) : person.roleCardCount > 0 ? (
              <span>· {person.roleCardCount} 张卡</span>
            ) : null}
          </div>
        </div>
        <IconButton
          icon={Trash2}
          label="删除人员"
          variant="danger"
          className="pp-person-delete"
          disabled={props.busy || queueBusy}
          onClick={(e) => {
            e.stopPropagation()
            props.onDelete(person)
          }}
        />
      </div>
    )
  }

  return (
    <aside className="pp-list-pane">
      <div className="pp-list-head">
        <div className="pp-list-title">
          <span>人员</span>
          <span className="pp-count">{props.people.length}</span>
        </div>
        <button
          type="button"
          className="pp-btn primary sm"
          onClick={props.onAdd}
          disabled={props.busy}
          title="新增人员"
        >
          <Icon icon={Plus} size={13} />
          新增
        </button>
      </div>

      <div className="pp-search">
        <Icon icon={Search} size={13} />
        <input
          value={props.query}
          onChange={(e) => props.onQueryChange(e.target.value)}
          placeholder="搜索人员或类型"
          aria-label="搜索人员"
        />
      </div>

      <div className="pp-list-scroll">
        {props.loading && props.people.length === 0 ? (
          <div className="pp-list-empty">加载中…</div>
        ) : filtered.length === 0 ? (
          <div className="pp-list-empty">
            {props.people.length === 0 ? '还没有人员，先新建一个吧' : '没有匹配的人员'}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.id || 'all'} className="pp-group">
              {props.groupByType ? (
                <div className="pp-group-head">
                  <span>{group.name}</span>
                  <span className="pp-count">{group.people.length}</span>
                </div>
              ) : null}
              {group.people.map(renderRow)}
            </div>
          ))
        )}
      </div>

      <div className="pp-list-foot">
        <PpCheckbox
          checked={props.groupByType}
          onChange={props.onGroupByTypeChange}
          label="按类型分组"
        />
        <button
          type="button"
          className="pp-link-btn"
          onClick={props.onEditTypes}
          disabled={props.busy}
        >
          <Icon icon={Settings2} size={13} />
          编辑类型
        </button>
      </div>
    </aside>
  )
}
