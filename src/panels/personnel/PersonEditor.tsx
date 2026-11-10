/**
 * 人员编辑页：顶部人员卡片（头像 / 名字 / 执行按钮）+ Aurabot 风格两级导航。
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import {
  Check,
  Home,
  Loader2,
  Pencil,
  Play,
  Send,
  Settings2,
  Square,
  UserRound,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import type { PersonDetail, PersonSummary, PersonType } from '@/shared/personnel'
import { Icon } from '@/shell/ui/Icon'
import { personnelApi } from './api'
import { DispatchTaskDialog } from './DispatchTaskDialog'
import { runStatusMeta } from './format'
import {
  PersonAvatar,
  PpSpinner,
  PpStatus,
} from './primitives'
import { OverviewTab } from './OverviewTab'
import { MemoryTab, NormsTab, RoleCardsTab } from './PersonaTabs'
import { GeneralTab, ModelTab, WorkspaceTab } from './SettingsTabs'

interface PersonEditorProps {
  person: PersonSummary
  detail: PersonDetail
  types: PersonType[]
  onRefresh: () => Promise<void>
  onEditTypes: () => void
}

type NavGroup = 'overview' | 'persona' | 'settings'
type PersonaTab = 'cards' | 'norms' | 'memory'
type SettingsTab = 'general' | 'model' | 'workspace'

const NAV_GROUPS: Array<{
  id: NavGroup
  label: string
  icon: typeof Home
  subs: Array<{ id: string; label: string }>
}> = [
  { id: 'overview', label: '概览', icon: Home, subs: [] },
  {
    id: 'persona',
    label: '人设',
    icon: UserRound,
    subs: [
      { id: 'cards', label: '角色卡' },
      { id: 'norms', label: '规范' },
      { id: 'memory', label: '记忆' },
    ],
  },
  {
    id: 'settings',
    label: '设置',
    icon: Settings2,
    subs: [
      { id: 'general', label: '常规' },
      { id: 'model', label: '模型' },
      { id: 'workspace', label: '工作区' },
    ],
  },
]

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key) as T | null
    return value && allowed.includes(value) ? value : fallback
  } catch {
    return fallback
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* localStorage 不可用：仅内存态 */
  }
}

export function PersonEditor(props: PersonEditorProps) {
  const { person, detail, types, onRefresh } = props
  const [group, setGroup] = useState<NavGroup>(() =>
    readStored<NavGroup>('bps.personnel.nav.group', ['overview', 'persona', 'settings'], 'overview'),
  )
  const [personaTab, setPersonaTab] = useState<PersonaTab>(() =>
    readStored<PersonaTab>('bps.personnel.nav.persona', ['cards', 'norms', 'memory'], 'cards'),
  )
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(() =>
    readStored<SettingsTab>(
      'bps.personnel.nav.settings',
      ['general', 'model', 'workspace'],
      'general',
    ),
  )
  const [runBusy, setRunBusy] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(person.name)
  const [uploading, setUploading] = useState(false)
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [dispatchInitial, setDispatchInitial] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const busy = person.run.status === 'running' || person.run.status === 'stopping'
  const running = person.run.status === 'running'
  const stopping = person.run.status === 'stopping'
  const meta = runStatusMeta(person.run.status)
  const typeName = types.find((t) => t.id === person.typeId)?.name ?? '未分类'
  const built = Boolean(detail.config.workspace.builtAt)

  useEffect(() => {
    store('bps.personnel.nav.group', group)
  }, [group])
  useEffect(() => {
    store('bps.personnel.nav.persona', personaTab)
  }, [personaTab])
  useEffect(() => {
    store('bps.personnel.nav.settings', settingsTab)
  }, [settingsTab])

  useEffect(() => {
    setEditingName(false)
    setNameDraft(person.name)
  }, [person.id, person.name])

  const pickGroup = (next: NavGroup): void => {
    setGroup(next)
  }

  const saveName = async (): Promise<void> => {
    const next = nameDraft.trim()
    if (!next) {
      toast.error('名字不能为空')
      return
    }
    if (next === person.name) {
      setEditingName(false)
      return
    }
    try {
      await personnelApi.update(person.id, { name: next })
      toast.success('名字已更新')
      setEditingName(false)
      await onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新名字失败')
    }
  }

  const onAvatarChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || busy) return
    if (!file.type.startsWith('image/')) {
      toast.error('请选择图片文件')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('头像不能超过 5MB')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      if (!dataUrl) return
      setUploading(true)
      void personnelApi
        .uploadAvatar(person.id, dataUrl)
        .then(async () => {
          toast.success('头像已更新')
          await onRefresh()
        })
        .catch((err: unknown) => {
          toast.error(err instanceof Error ? err.message : '上传头像失败')
        })
        .finally(() => setUploading(false))
    }
    reader.readAsDataURL(file)
  }

  const toggleRun = async (): Promise<void> => {
    if (runBusy || stopping) return
    setRunBusy(true)
    try {
      if (running) {
        const result = await personnelApi.stop(person.id)
        if (result.run.error?.startsWith('停止请求失败')) toast.error(result.run.error)
        else toast.success('已停止 DSH 会话')
      } else {
        await personnelApi.run(person.id)
        toast.success('已启动 DSH 会话，开始执行')
      }
      await onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : running ? '停止失败' : '启动失败')
    } finally {
      setRunBusy(false)
    }
  }

  const openDispatch = (task?: string): void => {
    if (busy) return
    setDispatchInitial(task ?? detail.config.task)
    setDispatchOpen(true)
  }

  const subTabs = group === 'persona' ? NAV_GROUPS[1]!.subs : group === 'settings' ? NAV_GROUPS[2]!.subs : []
  const activeSub = group === 'persona' ? personaTab : group === 'settings' ? settingsTab : ''

  return (
    <div className={`pp-editor${busy ? ' pp-busy' : ''}`}>
      <div className="pp-editor-scroll">
        <div className="pp-editor-inner">
          <header className="pp-hero">
            <button
              type="button"
              className="pp-avatar-btn"
              title={busy ? '执行中不能修改头像' : '点击更换头像'}
              disabled={busy || uploading}
              onClick={() => fileRef.current?.click()}
            >
              <PersonAvatar name={person.name} src={person.avatarUrl} size={76} />
              <span className="pp-avatar-tip">
                {uploading ? <Loader2 size={16} className="pp-spin" /> : '更换头像'}
              </span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              onChange={onAvatarChange}
            />

            <div className="pp-hero-main">
              <div className="pp-hero-name">
                {editingName ? (
                  <>
                    <input
                      className="pp-name-input"
                      value={nameDraft}
                      maxLength={40}
                      autoFocus
                      aria-label="人员名字"
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void saveName()
                        } else if (e.key === 'Escape') {
                          setEditingName(false)
                          setNameDraft(person.name)
                        }
                        e.stopPropagation()
                      }}
                    />
                    <button
                      type="button"
                      className="pp-icon-btn"
                      title="保存名字"
                      aria-label="保存名字"
                      onClick={() => void saveName()}
                    >
                      <Icon icon={Check} size={14} />
                    </button>
                    <button
                      type="button"
                      className="pp-icon-btn"
                      title="取消"
                      aria-label="取消修改名字"
                      onClick={() => {
                        setEditingName(false)
                        setNameDraft(person.name)
                      }}
                    >
                      <Icon icon={X} size={14} />
                    </button>
                  </>
                ) : (
                  <>
                    <h1>{person.name}</h1>
                    <button
                      type="button"
                      className="pp-name-edit"
                      title="修改名字"
                      aria-label="修改名字"
                      disabled={busy}
                      onClick={() => {
                        setNameDraft(person.name)
                        setEditingName(true)
                      }}
                    >
                      <Icon icon={Pencil} size={13} />
                    </button>
                  </>
                )}
              </div>
              <div className="pp-hero-sub">
                {typeName} · {person.roleCardCount} 张角色卡 · {person.memoryCount} 条记忆
              </div>
              <div className="pp-pills">
                <span className="pp-pill">
                  <PpStatus tone={meta.tone} label={meta.label} />
                </span>
                <span className="pp-pill">DSH</span>
                <span className="pp-pill">{built ? '工作区已构建' : '工作区待构建'}</span>
                <span className="pp-pill pp-pill-path" title={person.activeWorkspace}>
                  {person.activeWorkspace}
                </span>
              </div>
            </div>

            <div className="pp-hero-side">
              <div className="pp-run-row">
                <button
                  type="button"
                  className="pp-btn pp-dispatch-btn"
                  disabled={busy}
                  onClick={() => openDispatch()}
                  title="编辑任务并立即派发执行"
                >
                  <Icon icon={Send} size={14} />
                  派发任务
                </button>
                <button
                  type="button"
                  className={`pp-run-btn${running ? ' stop' : ''}`}
                  disabled={runBusy || stopping}
                  onClick={() => void toggleRun()}
                  title={running ? '停止 DSH 会话' : '构建工作区并创建 DSH 会话执行当前任务'}
                >
                  {runBusy || stopping ? (
                    <PpSpinner />
                  ) : running ? (
                    <Icon icon={Square} size={15} />
                  ) : (
                    <Icon icon={Play} size={15} />
                  )}
                  {stopping ? '停止中' : running ? '停止' : '执行'}
                </button>
              </div>
              <span className="pp-run-hint">
                {busy ? '执行中会锁定配置' : '构建工作区并开始任务'}
              </span>
            </div>
          </header>

          <nav className="pp-nav" aria-label="人员编辑导航">
            <div className="pp-nav-groups" role="tablist" aria-label="一级菜单">
              {NAV_GROUPS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={group === item.id}
                  className={`pp-nav-group${group === item.id ? ' on' : ''}`}
                  onClick={() => pickGroup(item.id)}
                >
                  <Icon icon={item.icon} size={15} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
            {subTabs.length > 0 ? (
              <div className="pp-nav-sub" role="tablist" aria-label="二级菜单">
                {subTabs.map((item) => {
                  const active = activeSub === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      className={`pp-nav-tab${active ? ' on' : ''}`}
                      onClick={() => {
                        if (group === 'persona') setPersonaTab(item.id as PersonaTab)
                        else setSettingsTab(item.id as SettingsTab)
                      }}
                    >
                      {item.label}
                    </button>
                  )
                })}
              </div>
            ) : null}
          </nav>

          {busy ? (
            <div className="pp-lock-note">
              执行中，配置已锁定。点击右上角「停止」结束 DSH 会话后即可继续编辑。
            </div>
          ) : null}

          <div className="pp-content">
            <div className="pp-tab-pane" hidden={group !== 'overview'}>
              <OverviewTab
                key={person.id}
                person={person}
                detail={detail}
                busy={busy}
                onRefresh={onRefresh}
                onDispatch={openDispatch}
              />
            </div>
            <div className="pp-tab-pane" hidden={group !== 'persona' || personaTab !== 'cards'}>
              <RoleCardsTab key={person.id} detail={detail} busy={busy} onRefresh={onRefresh} />
            </div>
            <div className="pp-tab-pane" hidden={group !== 'persona' || personaTab !== 'norms'}>
              <NormsTab key={person.id} detail={detail} busy={busy} onRefresh={onRefresh} />
            </div>
            <div className="pp-tab-pane" hidden={group !== 'persona' || personaTab !== 'memory'}>
              <MemoryTab key={person.id} detail={detail} busy={busy} onRefresh={onRefresh} />
            </div>
            <div className="pp-tab-pane" hidden={group !== 'settings' || settingsTab !== 'general'}>
              <GeneralTab
                key={person.id}
                detail={detail}
                busy={busy}
                onRefresh={onRefresh}
                types={types}
                onEditTypes={props.onEditTypes}
              />
            </div>
            <div className="pp-tab-pane" hidden={group !== 'settings' || settingsTab !== 'model'}>
              <ModelTab key={person.id} detail={detail} busy={busy} onRefresh={onRefresh} />
            </div>
            <div className="pp-tab-pane" hidden={group !== 'settings' || settingsTab !== 'workspace'}>
              <WorkspaceTab key={person.id} detail={detail} busy={busy} onRefresh={onRefresh} />
            </div>
          </div>
        </div>
      </div>
      {dispatchOpen ? (
        <DispatchTaskDialog
          personId={person.id}
          personName={person.name}
          initialTask={dispatchInitial}
          onClose={() => setDispatchOpen(false)}
          onDispatched={onRefresh}
        />
      ) : null}
    </div>
  )
}
