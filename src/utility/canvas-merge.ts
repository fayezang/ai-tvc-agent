/**
 * 合并来自 renderer 的画布保存。
 *
 * ## 为什么需要合并而不是直接覆盖
 *
 * renderer 的保存有 260ms 防抖，触发时它手里是**防抖开始那一刻**的节点列表。
 * 与此同时 Utility Process 会在后台创建节点（生成分镜时每个镜头一个节点）。
 * 时序：
 *
 *   1. 用户拖动画布 → renderer 排期一次保存，快照里没有分镜节点
 *   2. 后台创建分镜节点 → 写入 canvas.json
 *   3. renderer 防抖到期 → 用第 1 步的旧快照整体覆盖 → 分镜节点被抹掉
 *   4. 后台回头更新该节点状态 → 「找不到要更新的节点」
 *
 * 根因是两个进程都以「我手上这份就是全部」的方式写同一个文件，而 renderer
 * 那份必然滞后。缩短防抖只能让窗口变窄，不能消除竞争。
 *
 * ## 职责划分
 *
 * - **renderer 拥有布局**：位置、尺寸、视口。这些只有用户拖拽才会变。
 * - **磁盘拥有结构**：节点是否存在、状态、标题、所属镜头等业务字段。
 *   这些只由 Utility Process 写入。
 *
 * 因此合并时以磁盘为准，只从 renderer 取布局。
 */

import type { CanvasSnapshot } from "../shared/contracts.js";

/**
 * @param current 磁盘上的当前快照，结构的唯一事实源
 * @param incoming renderer 提交的快照，仅取其布局信息
 */
export const mergeCanvasFromClient = (
  current: CanvasSnapshot,
  incoming: CanvasSnapshot
): CanvasSnapshot => {
  const incomingNodes = new Map(incoming.nodes.map((node) => [node.id, node]));

  const nodes = current.nodes.map((node) => {
    const layout = incomingNodes.get(node.id);
    // 磁盘上有、renderer 不知道的节点：后台在防抖期间新建的，原样保留。
    // 这正是修复前被抹掉的那一类。
    if (!layout) return node;
    // 只接受布局，业务字段一律以磁盘为准——renderer 手上的 status
    // 可能停留在 generating，而后台已经把它推进到 completed 了。
    return {
      ...node,
      position: layout.position,
      ...(layout.width === undefined ? {} : { width: layout.width }),
      ...(layout.height === undefined ? {} : { height: layout.height })
    };
  });

  // renderer 有、磁盘没有的节点不予恢复：那是后台已经删除的，
  // 恢复它会让用户删掉的东西自己长回来。

  const liveNodeIds = new Set(nodes.map((node) => node.id));
  const knownToClient = new Set(incoming.nodes.map((node) => node.id));

  // 边的处理分两类：
  // - renderer 见过的边：以 renderer 为准，用户可以删除自己画的连线
  // - 端点涉及 renderer 未见过的节点：它不可能知道这条边，只能是后台建的，予以保留
  const clientEdges = incoming.edges.filter(
    (edge) => liveNodeIds.has(edge.source) && liveNodeIds.has(edge.target)
  );
  const clientEdgeIds = new Set(clientEdges.map((edge) => edge.id));
  const backendEdges = current.edges.filter((edge) => {
    if (clientEdgeIds.has(edge.id)) return false;
    if (!liveNodeIds.has(edge.source) || !liveNodeIds.has(edge.target)) return false;
    return !knownToClient.has(edge.source) || !knownToClient.has(edge.target);
  });

  return {
    version: current.version,
    nodes,
    edges: [...clientEdges, ...backendEdges],
    // 视口纯粹是 renderer 的显示状态，后台从不修改它。
    viewport: incoming.viewport
  };
};
