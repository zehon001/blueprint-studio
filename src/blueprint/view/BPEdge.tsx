/**
 * Blueprint Studio v2 —— 蓝图连线渲染器（T2.1，PLAN §8.1 连线复刻）
 *
 * 自定义 edgeTypes（exec → 'bpExec'，data → 'bpData'），贝塞尔曲线（getBezierPath）：
 * - exec：实线白（--edge-exec）+ 三角端头（markerEnd 由 irToFlow 生成，SVG marker 取 rawToken）；
 * - data：按引脚类型着色虚线（颜色经内联 CSS 变量 --bp-edge-color 传入，stroke 本体由 CSS 控制）；
 * - 选中 / 悬停 / 流动动画态全部走 CSS 类（避免内联 stroke 覆盖选中高亮）：
 *   .react-flow__edge.selected / :hover / .bp-edge--flow（T5.4 激活）。
 */
import type { CSSProperties } from 'react';
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';
import { pinColor } from '../../shell/theme/tokens';
import type { FlowEdge } from './model';

/** 内联样式携带 CSS 变量（stroke 由 styles.css 按类名取用） */
function cssVars(vars: Record<string, string>): CSSProperties {
  return vars as CSSProperties;
}

function bezierPath(props: EdgeProps<FlowEdge>): string {
  const [path] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
    curvature: 0.35,
  });
  return path;
}

/** exec 连线：实线白 + 三角端头 */
export function BPExecEdge(props: EdgeProps<FlowEdge>) {
  const path = bezierPath(props);
  const flowing = props.data?.flowing ? ' bp-edge--flow' : '';
  return (
    <BaseEdge
      path={path}
      markerEnd={props.markerEnd}
      className={`bp-edge-path bp-edge-exec${flowing}`}
    />
  );
}

/** 数据连线：按引脚类型着色虚线（pinType 见 irToFlow；未知类型回落 --edge-data-default） */
export function BPDataEdge(props: EdgeProps<FlowEdge>) {
  const path = bezierPath(props);
  const color = pinColor(props.data?.pinType ?? 'any');
  const flowing = props.data?.flowing ? ' bp-edge--flow' : '';
  return (
    <BaseEdge
      path={path}
      className={`bp-edge-path bp-edge-data${flowing}`}
      style={cssVars({ '--bp-edge-color': color })}
    />
  );
}
