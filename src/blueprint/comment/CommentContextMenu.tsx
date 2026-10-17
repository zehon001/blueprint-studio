/**
 * Blueprint Studio v2 —— 注释框右键菜单（T2.7 / ADR-006，DoD 3）
 *
 * 右键注释标题弹出：预设色板 6 色（点击即换、菜单保持打开便于试色）+
 * 自定义 color input + 恢复默认色 / 大小重置 / 删除注释（仅删注释不动节点）。
 * 复用 interaction.css 的 .bp-menu 视觉（面板已引入）；菜单开合由 store.menu
 * 统一管理（Esc / 空白点击 / 视口移动自动关闭，与节点搜索菜单同款）。
 */
import { useEffect, useRef, useState } from 'react';
import type { IRComment, Vec2 } from '../../ir/types';
import { clampMenuPosition } from '../interaction/logic';
import { useBlueprintStore } from '../store/blueprint-store';
import { COMMENT_PRESET_COLORS } from './model';

/** 菜单近似尺寸（视口收敛用） */
const MENU_WIDTH = 216;
const MENU_HEIGHT = 200;

export interface CommentContextMenuProps {
  /** 目标注释（当前色高亮 / color input 初值用） */
  comment: IRComment;
  /** 屏幕坐标（fixed 定位） */
  screen: Vec2;
  onClose: () => void;
}

/** 非 #rrggbb 颜色的 color input 兜底值（灰） */
const FALLBACK_HEX = '#9e9e9e';

export function CommentContextMenu({ comment, screen, onClose }: CommentContextMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [customColor, setCustomColor] = useState(
    /^#[0-9a-fA-F]{6}$/.test(comment.color ?? '') ? (comment.color as string) : FALLBACK_HEX,
  );

  // 点击外部 / Esc 关闭（与 EdgeContextMenu 同款；store.menu 的统一关闭路径之外的双保险）
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const st = () => useBlueprintStore.getState();
  const pos = clampMenuPosition(screen, MENU_WIDTH, MENU_HEIGHT);

  return (
    <div
      ref={rootRef}
      className="bp-menu bp-comment-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      aria-label="注释菜单"
    >
      <div className="bp-menu-header">注释</div>
      <div className="bp-comment-menu-colors" role="group" aria-label="注释颜色">
        {COMMENT_PRESET_COLORS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            role="menuitemradio"
            aria-checked={comment.color === preset.value}
            aria-label={preset.label}
            title={preset.label}
            className={`bp-comment-swatch${comment.color === preset.value ? ' bp-comment-swatch--active' : ''}`}
            style={{ background: preset.value }}
            onClick={() => st().setCommentColor(comment.id, preset.value)}
          />
        ))}
        <label className="bp-comment-swatch bp-comment-swatch--custom" title="自定义颜色">
          <input
            type="color"
            aria-label="自定义颜色"
            value={customColor}
            onChange={(e) => {
              setCustomColor(e.target.value);
              st().setCommentColor(comment.id, e.target.value);
            }}
          />
        </label>
      </div>
      <button
        type="button"
        role="menuitem"
        className="bp-menu-item"
        onClick={() => st().setCommentColor(comment.id, undefined)}
      >
        恢复默认色
      </button>
      <button
        type="button"
        role="menuitem"
        className="bp-menu-item"
        onClick={() => {
          st().resetCommentSize(comment.id);
          onClose();
        }}
      >
        大小重置
      </button>
      <div className="bp-comment-menu-sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="bp-menu-item bp-menu-item--danger"
        onClick={() => {
          st().removeComments([comment.id]);
          onClose();
        }}
      >
        删除注释
      </button>
    </div>
  );
}
