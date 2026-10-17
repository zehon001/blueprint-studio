/**
 * Blueprint Studio v2 —— 引脚拖出兼容菜单（T2.2，PLAN §8.2 第 2 条）
 *
 * 从引脚拖出连线、松开在画布空白 → 在光标处弹出「只列兼容节点」的菜单：
 *  - 从输出引脚拖出：只列「该引脚类型可接入其输入」的节点（可赋值 / any）；
 *    exec 引脚只列有 exec 输入的节点（纯节点无 exec 输入，天然被排除）；
 *  - 从输入引脚拖出：只列「其输出可接入该引脚」的节点；
 *  - 选中即建节点 + 自动连线（addNodeConnected，入命令栈可撤销）。
 * 列表 UI 复用 NodeSearchMenu（搜索 / 分类 / 最近使用 / 键盘导航同款）。
 * 样式由 BlueprintEditorPanel 统一 import（node:test 环境无法加载 .css）。
 */
import { useMemo } from 'react';
import type { NodeSpec, Vec2 } from '../../ir/types';
import { NodeSearchMenu } from './NodeSearchMenu';
import { compatibleSpecEntries, type PinRef } from './logic';

export interface PinDragMenuProps {
  /** 菜单屏幕坐标（松开点） */
  screen: Vec2;
  /** 菜单画布坐标（选中后建节点的位置） */
  flow: Vec2;
  /** 拖出引脚引用（类型已解析；未知节点降级 any） */
  from: PinRef;
  /** 节点定义表（store.specs，含插件节点） */
  specs: ReadonlyMap<string, NodeSpec>;
  /** 最近使用 spec id（LRU） */
  recentIds: readonly string[];
  /** 分类展示顺序（节点库 NODE_CATEGORIES） */
  categoryOrder: readonly string[];
  /** 选中兼容节点：建节点 + 自动连线（由 BlueprintEditorPanel 接 store） */
  onPick: (specId: string) => void;
  onClose: () => void;
}

/** 引脚拖出兼容菜单：过滤只留兼容节点后复用搜索菜单 UI */
export function PinDragMenu({
  screen,
  from,
  specs,
  recentIds,
  categoryOrder,
  onPick,
  onClose,
}: PinDragMenuProps) {
  // flow（建节点的画布坐标）由面板层经 store.menu.flow 取用，本组件只做兼容过滤与展示
  const entries = useMemo(() => compatibleSpecEntries(specs, from), [specs, from]);
  const dirLabel = from.dir === 'out' ? '从「输出」拖出' : '接入「输入」';
  const handlePick = (specId: string): void => {
    onPick(specId);
    onClose();
  };
  return (
    <NodeSearchMenu
      screen={screen}
      entries={entries}
      recentIds={recentIds}
      categoryOrder={categoryOrder}
      title={`可连接的节点（${dirLabel}，类型 ${from.type ?? 'any'}）`}
      onPick={handlePick}
      onClose={onClose}
    />
  );
}
