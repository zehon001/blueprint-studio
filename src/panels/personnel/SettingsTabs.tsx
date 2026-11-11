/**
 * 设置：常规 / 模型 / 工作区。
 */
import { useEffect, useState } from 'react'
import {
  FolderOpen,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { toast } from 'sonner'
import type { PersonDetail, PersonType } from '@/shared/personnel'
import { Icon } from '@/shell/ui/Icon'
import { personnelApi, type PersonCapabilities } from './api'
import { formatDateTime } from './format'
import {
  ConfirmDialog,
  PpRow,
  PpSectionCard,
  PpSelect,
  PpSpinner,
  PpSwitch,
  PpTextField,
  PersonAvatar,
  type PpOption,
} from './primitives'

interface SettingsTabProps {
  detail: PersonDetail
  busy: boolean
  onRefresh: () => Promise<void>
}

const REASONING_LABELS: Record<string, string> = {
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  max: '最高',
}

const PERMISSION_LABELS: Record<string, string> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'danger-full-access': '完全访问',
}

function reasoningLabel(value: string): string {
  return REASONING_LABELS[value] ?? value
}

function permissionLabel(value: string): string {
  return PERMISSION_LABELS[value] ?? value
}

async function patch(
  id: string,
  input: Parameters<typeof personnelApi.update>[1],
  onRefresh: () => Promise<void>,
  message: string,
): Promise<void> {
  try {
    await personnelApi.update(id, input)
    toast.success(message)
    await onRefresh()
  } catch (err) {
    toast.error(err instanceof Error ? err.message : '保存失败')
  }
}

export function GeneralTab(props: SettingsTabProps & {
  types: PersonType[]
  onEditTypes: () => void
}) {
  const { detail, types, busy, onRefresh } = props
  return (
    <div className="pp-grid">
      <PpSectionCard
        title="人员类型"
        desc="类型用于列表分组和交付要求；交付目录、产物类型在「编辑类型」里设置。"
        right={
          <button type="button" className="pp-btn sm" onClick={props.onEditTypes} disabled={busy}>
            <Icon icon={SlidersHorizontal} size={13} />
            编辑类型
          </button>
        }
      >
        <PpRow label="类型" hint="修改后立即保存">
          <PpSelect
            value={detail.config.typeId}
            options={[
              ...types.map((type) => ({ value: type.id, label: type.name })),
              { value: '', label: '未分类' },
            ]}
            onChange={(typeId) =>
              void patch(detail.id, { typeId }, onRefresh, '人员类型已更新')
            }
            disabled={busy}
            placeholder="未分类"
            ariaLabel="人员类型"
          />
        </PpRow>
      </PpSectionCard>

      <PpSectionCard title="身份信息">
        <div className="pp-identity">
          <PersonAvatar name={detail.name} src={detail.avatarUrl} size={56} />
          <div>
            <b>{detail.name}</b>
            <span>创建于 {formatDateTime(detail.createdAt)}</span>
          </div>
        </div>
        <div className="pp-kv pp-identity-kv">
          <span>默认工作区</span>
          <span className="pp-mono pp-path">{detail.defaultWorkspace}</span>
          <span>当前工作区</span>
          <span className="pp-mono pp-path">{detail.activeWorkspace}</span>
        </div>
        <p className="pp-dialog-desc">
          名字和头像直接点击上方人员卡片修改；这里只展示身份信息。
        </p>
      </PpSectionCard>

      <PpSectionCard
        title="任务执行"
        desc="并行数大于 1 时，主会话按 AGENTS.md 协议开子会话并行执行；任务看板仍由主会话唯一写入。"
      >
        <PpRow label="并行任务数" hint="1 = 串行；建议 2~3，最多 8">
          <PpSelect
            value={String(detail.config.parallelism)}
            options={Array.from({ length: 8 }, (_, index) => {
              const value = String(index + 1)
              return { value, label: value }
            })}
            onChange={(value) =>
              void patch(detail.id, { parallelism: Number(value) }, onRefresh, '并行任务数已更新')
            }
            disabled={busy}
            ariaLabel="并行任务数"
          />
        </PpRow>
      </PpSectionCard>
    </div>
  )
}

export function ModelTab(props: SettingsTabProps) {
  const { detail, busy, onRefresh } = props
  const [caps, setCaps] = useState<PersonCapabilities | null>(null)
  const [loadingCaps, setLoadingCaps] = useState(true)
  const [savingKey, setSavingKey] = useState('')
  const model = detail.config.model

  const loadCaps = async (): Promise<void> => {
    setLoadingCaps(true)
    setCaps(await personnelApi.capabilities())
    setLoadingCaps(false)
  }

  useEffect(() => {
    void loadCaps()
  }, [detail.id])

  const updateModel = async (
    key: 'model' | 'reasoning' | 'permission',
    value: string,
  ): Promise<void> => {
    setSavingKey(key)
    try {
      await personnelApi.update(detail.id, { model: { [key]: value } })
      toast.success('模型设置已保存')
      await onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存模型设置失败')
    } finally {
      setSavingKey('')
    }
  }

  const modelOptions: PpOption[] = (caps?.models ?? []).map((m) => ({
    value: m.id,
    label: m.name,
    hint: m.id,
  }))
  if (model.model && !modelOptions.some((o) => o.value === model.model)) {
    modelOptions.unshift({ value: model.model, label: model.model, hint: '当前保存值' })
  }
  modelOptions.unshift({ value: '', label: '跟随 DSH 默认' })
  const reasoningOptions: PpOption[] = (caps?.reasoningLevels ?? []).map((value) => ({
    value,
    label: reasoningLabel(value),
  }))
  if (model.reasoning && !reasoningOptions.some((o) => o.value === model.reasoning)) {
    reasoningOptions.unshift({ value: model.reasoning, label: reasoningLabel(model.reasoning) })
  }
  reasoningOptions.unshift({ value: '', label: '跟随 DSH 默认' })
  const permissionOptions: PpOption[] = (caps?.permissions ?? []).map((value) => ({
    value,
    label: permissionLabel(value),
    hint: value,
  }))
  if (model.permission && !permissionOptions.some((o) => o.value === model.permission)) {
    permissionOptions.unshift({
      value: model.permission,
      label: permissionLabel(model.permission),
      hint: '当前保存值',
    })
  }
  permissionOptions.unshift({ value: '', label: '跟随 DSH 默认' })

  return (
    <div className="pp-grid">
      <PpSectionCard
        title="模型"
        desc="执行时创建 / 复用 DSH 会话会使用这里的平台、大模型、思考强度与权限。"
        right={
          <div className="pp-card-right">
            <span className={`pp-conn${caps?.connected ? ' on' : ''}`}>
              <Icon icon={caps?.connected ? Wifi : WifiOff} size={13} />
              {loadingCaps ? '检测中' : caps?.connected ? 'DSH 已连接' : 'DSH 未连接'}
            </span>
            <button
              type="button"
              className="pp-icon-btn"
              title="刷新模型目录"
              aria-label="刷新模型目录"
              disabled={loadingCaps}
              onClick={() => void loadCaps()}
            >
              <Icon icon={RefreshCw} size={13} className={loadingCaps ? 'pp-spin' : undefined} />
            </button>
          </div>
        }
      >
        <PpRow label="平台" hint="目前仅支持 DSH">
          <PpSelect
            value="dsh"
            options={[{ value: 'dsh', label: 'DSH（DeepSeek Harness）' }]}
            onChange={() => undefined}
            disabled
            ariaLabel="平台"
          />
        </PpRow>
        <PpRow
          label="大模型"
          hint={
            caps && caps.models.length === 0
              ? 'DSH 未连上或没有返回模型；可以先手填模型 id'
              : '新建 / 复用会话时应用'
          }
        >
          {modelOptions.length > 0 ? (
            <PpSelect
              value={model.model}
              options={modelOptions}
              onChange={(value) => void updateModel('model', value)}
              disabled={busy || savingKey === 'model'}
              placeholder="跟随 DSH 默认"
              ariaLabel="大模型"
              width={320}
            />
          ) : (
            <PpTextField
              value={model.model}
              onCommit={(value) => void updateModel('model', value)}
              disabled={busy || savingKey === 'model'}
              placeholder="比如 group/glm-5.3"
              ariaLabel="大模型"
            />
          )}
        </PpRow>
        <PpRow label="思考强度" hint="空 = 跟随 DSH 默认">
          {reasoningOptions.length > 0 ? (
            <PpSelect
              value={model.reasoning}
              options={reasoningOptions}
              onChange={(value) => void updateModel('reasoning', value)}
              disabled={busy || savingKey === 'reasoning'}
              placeholder="跟随 DSH 默认"
              ariaLabel="思考强度"
              width={220}
            />
          ) : (
            <PpTextField
              value={model.reasoning}
              onCommit={(value) => void updateModel('reasoning', value)}
              disabled={busy || savingKey === 'reasoning'}
              placeholder="low / high / max"
              ariaLabel="思考强度"
            />
          )}
        </PpRow>
        <PpRow label="权限" hint="空 = 跟随 DSH profile 的默认权限">
          {permissionOptions.length > 0 ? (
            <PpSelect
              value={model.permission}
              options={permissionOptions}
              onChange={(value) => void updateModel('permission', value)}
              disabled={busy || savingKey === 'permission'}
              placeholder="跟随 DSH 默认"
              ariaLabel="权限"
              width={260}
            />
          ) : (
            <PpTextField
              value={model.permission}
              onCommit={(value) => void updateModel('permission', value)}
              disabled={busy || savingKey === 'permission'}
              placeholder="danger-full-access"
              ariaLabel="权限"
            />
          )}
        </PpRow>
        {caps && !caps.connected ? (
          <div className="pp-note">
            DSH 当前未连接，目录暂时读不到。已保存的设置会保留，等 DSH 启动后执行时生效。
          </div>
        ) : null}
      </PpSectionCard>
    </div>
  )
}

export function WorkspaceTab(props: SettingsTabProps) {
  const { detail, busy, onRefresh } = props
  const workspace = detail.config.workspace
  const [building, setBuilding] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [picking, setPicking] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  const chooseDir = async (): Promise<void> => {
    setPicking(true)
    try {
      const dir = await personnelApi.selectDirectory()
      if (!dir) {
        toast.info('已取消选择目录')
        return
      }
      await patch(detail.id, { workspace: { dir } }, onRefresh, '工作区目录已保存')
    } finally {
      setPicking(false)
    }
  }

  const build = async (): Promise<void> => {
    setBuilding(true)
    try {
      const result = await personnelApi.buildWorkspace(detail.id)
      const moved = result.moved.length
      const skipped = result.skipped.length
      toast.success(
        workspace.dir
          ? `已把默认工作区文件移动到目标目录${moved ? `（移动 ${moved} 项）` : ''}${
              skipped ? `，${skipped} 项已存在被保留` : ''
            }`
          : '已刷新默认工作区',
      )
      await onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '构建工作区失败')
    } finally {
      setBuilding(false)
    }
  }

  const reset = async (): Promise<void> => {
    setResetting(true)
    try {
      await personnelApi.resetWorkspace(detail.id)
      toast.success('工作区已重置，AGENTS / TASK / STATE / 记忆已重新生成')
      setConfirmReset(false)
      await onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重置工作区失败')
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className="pp-grid">
      <PpSectionCard
        title="工作区"
        desc="工作区目录留空时使用默认工作区。构建会把默认工作区里的文件移动到设置的工作区；执行时会自动构建。"
      >
        <PpRow label="工作区目录" hint="和蓝图节点一样，通过系统目录选择窗口设置">
          <div className="pp-dir-row">
            <span className="pp-dir-value pp-mono pp-path" title={workspace.dir || detail.defaultWorkspace}>
              {workspace.dir || detail.defaultWorkspace}
            </span>
            <button
              type="button"
              className="pp-btn sm"
              onClick={() => void chooseDir()}
              disabled={busy || picking}
            >
              <Icon icon={FolderOpen} size={13} />
              {picking ? '选择中…' : '选择目录'}
            </button>
            {workspace.dir ? (
              <button
                type="button"
                className="pp-btn ghost sm"
                disabled={busy}
                onClick={() =>
                  void patch(detail.id, { workspace: { dir: '' } }, onRefresh, '已恢复默认工作区')
                }
              >
                清除
              </button>
            ) : null}
          </div>
        </PpRow>
        <PpRow label="会话标题" hint="留空 = 自动生成「名字 · 类型」">
          <PpTextField
            value={workspace.sessionTitle}
            onCommit={(value) =>
              void patch(detail.id, { workspace: { sessionTitle: value } }, onRefresh, '会话标题已保存')
            }
            disabled={busy}
            placeholder="比如：客服小蓝 · 日常任务"
            ariaLabel="会话标题"
          />
        </PpRow>
        <PpRow label="执行完毕删除会话" hint="完成后归档 DSH 会话；STATE.md 与记忆仍保留">
          <PpSwitch
            on={workspace.deleteSessionAfterRun}
            disabled={busy}
            ariaLabel="执行完毕删除会话"
            onChange={(value) =>
              void patch(
                detail.id,
                { workspace: { deleteSessionAfterRun: value } },
                onRefresh,
                value ? '执行完毕将删除会话' : '执行完毕将保留会话',
              )
            }
          />
        </PpRow>
        <PpRow label="复用会话" hint="关闭后每次执行都会新建会话">
          <PpSwitch
            on={workspace.reuseSession}
            disabled={busy}
            ariaLabel="复用会话"
            onChange={(value) =>
              void patch(
                detail.id,
                { workspace: { reuseSession: value } },
                onRefresh,
                value ? '将复用上一次会话' : '每次执行新建会话',
              )
            }
          />
        </PpRow>

        <div className="pp-workspace-actions">
          <button
            type="button"
            className="pp-btn primary"
            onClick={() => void build()}
            disabled={busy || building}
          >
            {building ? <PpSpinner /> : <Icon icon={FolderOpen} size={14} />}
            构建工作区
          </button>
          <button
            type="button"
            className="pp-btn danger ghost"
            onClick={() => setConfirmReset(true)}
            disabled={busy || building}
          >
            <Icon icon={RotateCcw} size={14} />
            重置工作区
          </button>
          {busy ? <span className="pp-muted">执行中不能操作</span> : null}
        </div>
      </PpSectionCard>

      <PpSectionCard title="目录信息">
        <div className="pp-kv">
          <span>当前生效</span>
          <span className="pp-mono pp-path">{detail.activeWorkspace}</span>
          <span>默认工作区</span>
          <span className="pp-mono pp-path">{detail.defaultWorkspace}</span>
          <span>最近构建</span>
          <span>{workspace.builtAt ? formatDateTime(workspace.builtAt) : '尚未构建'}</span>
          <span>主要文件</span>
          <span>AGENTS.md · PERSON.md · TASK.md · STATE.md · memory/</span>
        </div>
        <p className="pp-dialog-desc">
          STATE.md 是会话删除 / 重建后继续工作的关键；重置会清空它并重新生成默认进度。
        </p>
      </PpSectionCard>

      {confirmReset ? (
        <ConfirmDialog
          title="重置工作区"
          message="会删除当前工作区与默认工作区里的 AGENTS.md、PERSON.md、TASK.md、STATE.md 和 memory/，并重新生成默认文件。角色卡、规范、模型设置不会丢失。"
          confirmLabel="重置工作区"
          danger
          busy={resetting}
          onConfirm={() => void reset()}
          onClose={() => setConfirmReset(false)}
        />
      ) : null}
    </div>
  )
}
