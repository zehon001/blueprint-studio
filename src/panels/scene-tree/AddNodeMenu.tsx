/**
 * 「添加节点」浮层菜单（T1.4 · PLAN §7.2 右键菜单）
 *
 * 内联搜索框（searchUISchemas 模糊匹配）+ 按 NODE_CATEGORIES 分组列表；
 * 由 UI 树面板在空白 / 根节点 / 容器节点「添加子节点」处唤起，选中即经
 * commands.addUINodeCommand 入栈（「树：添加节点」）。
 *
 * 行为对齐通用 Menu（file-system/Menu.tsx）：portal 到 body、视口边缘钳位、
 * 点击菜单外（pointerdown）/ Esc 关闭；本组件自持搜索态。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { NODE_CATEGORIES, searchUISchemas, type UINodeSchema } from '@/ui-editor/schema';
import { Icon } from '@/shell/ui/Icon';
import { schemaIconFor, uiCategoryColor } from '@/shell/ui/icons';

export interface AddNodeMenuProps {
  /** 视口坐标（通常取 contextmenu 事件的 clientX / clientY） */
  x: number;
  y: number;
  /** 选中某个节点 schema（执行后菜单由调用方关闭） */
  onPick: (schema: UINodeSchema) => void;
  onClose: () => void;
}

/** 视口内边距（钳位时保留的最小间隙） */
const VIEWPORT_GAP = 4;
/** 列表最大高度（超出滚动） */
const LIST_MAX_HEIGHT = 288;

export function AddNodeMenu({ x, y, onPick, onClose }: AddNodeMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [kw, setKw] = useState('')
  const [pos, setPos] = useState({ x, y })

  const results = searchUISchemas(kw)
  const groups = NODE_CATEGORIES.map((category) => ({
    category,
    items: results.filter((s) => s.category === category),
  })).filter((g) => g.items.length > 0)

  // 挂载 / 关键字变化后测量实际尺寸，越界则钳回视口内
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const nx = x + rect.width > window.innerWidth - VIEWPORT_GAP
      ? Math.max(VIEWPORT_GAP, window.innerWidth - rect.width - VIEWPORT_GAP)
      : x
    const ny = y + rect.height > window.innerHeight - VIEWPORT_GAP
      ? Math.max(VIEWPORT_GAP, window.innerHeight - rect.height - VIEWPORT_GAP)
      : y
    setPos({ x: nx, y: ny })
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (e: Event): void => {
      const target = e.target
      if (ref.current && target instanceof Node && ref.current.contains(target)) return
      onClose()
    }
    const onKeyDown = (e: Event): void => {
      if ((e as KeyboardEvent).key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const style: CSSProperties = { left: pos.x, top: pos.y }
  return createPortal(
    <div ref={ref} className="st-addmenu" role="menu" aria-label="添加节点" style={style}>
      <div className="st-addmenu-searchwrap">
        <Icon icon={Search} size={13} />
        <input
          className="st-addmenu-search"
          value={kw}
          placeholder="搜索节点…"
          spellCheck={false}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && results.length > 0) onPick(results[0])
          }}
        />
      </div>
      <div className="st-addmenu-list" style={{ maxHeight: LIST_MAX_HEIGHT }}>
        {groups.map((g) => (
          <div key={g.category} className="st-addmenu-group-wrap">
            <div className="st-addmenu-group">{g.category}</div>
            {g.items.map((s) => (
              <button
                key={s.type}
                type="button"
                role="menuitem"
                className="st-addmenu-item"
                title={s.keywords?.join(' · ')}
                onClick={() => onPick(s)}
              >
                <span
                  className="st-addmenu-icon"
                  aria-hidden
                  style={{ color: uiCategoryColor(s.category), background: 'var(--bg-input)' }}
                >
                  <Icon icon={schemaIconFor(s.type, s.category)} size={13} />
                </span>
                <span className="st-addmenu-title">{s.title}</span>
                <span className="st-addmenu-type">{s.type}</span>
              </button>
            ))}
          </div>
        ))}
        {groups.length === 0 ? <div className="st-addmenu-empty">无匹配节点</div> : null}
      </div>
    </div>,
    document.body,
  )
}
