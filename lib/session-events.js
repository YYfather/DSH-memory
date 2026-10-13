/**
 * dsh-memory-evolve — 会话事件日志读取兼容层（DSH 0.2.x 适配）。
 *
 * 背景：DSH 0.1.2-alpha.4 起 `Session` **不再暴露 `.events` 数组属性**，改由
 * `snapshotEvents()`（全量日志）与 `ownEvents()`（本会话 fork 切点之后的事件）
 * 提供。读 `session.events` 只会得到 `undefined`，于是所有依赖日志的守卫与
 * 功能**静默失效**（典型：issue #90 —— skill_manage 的「先读后写」证据永远
 * 查不到，patch 永久不可用；见 lib/skills.js hasReadSkill）。
 *
 * 0.2.0-rc.2 起 `eventAt()` / `snapshotEvents()` / `ownEvents()` 被标记为
 * **废弃但仍可用**（官方措辞：既有逻辑可以暂不迁移，新生产调用禁止），因此
 * 本模块把它们当作老宿主（仍只有 `.events`）与新宿主之间的**兼容兜底**使用，
 * 而不是迁移到新的投影（projection）API——迁移超出本次兼容修复的范围。
 *
 * 语义边界（调用方依赖）：
 *   - 读不到日志时返回 `undefined`，**绝不强制转成 `[]`**：调用方需要区分
 *     「会话不在本进程 / 日志不可读」（报错或明确提示）与「日志为空」（正常
 *     的空结果）；
 *   - 单个取值器抛错视为该取值器不可用（继续尝试下一个），不把「读不到」
 *     升级成异常打断状态查询之类的调用方。
 *
 * 零依赖（本文件**无任何 import**）：lib/store.js 与 lib/sync/* 之间互相
 * 引用密集，helper 若反向依赖它们会引入循环 import 风险，故刻意不引入任何
 * 模块。
 *
 * @module dsh-memory-evolve/session-events
 */

/**
 * 解析出会话对象：既接受 agent（`{ session }`），也接受 session 本身。
 * @param {object | undefined | null} agentOrSession
 * @returns {object | undefined} 会话对象；非法输入返回 undefined。
 */
function resolveSession(agentOrSession) {
  if (!agentOrSession || typeof agentOrSession !== 'object') return undefined
  const session = agentOrSession.session ?? agentOrSession
  return session && typeof session === 'object' ? session : undefined
}

/**
 * 依次尝试取值器，返回第一个「数组」结果。
 * 单个取值器抛错视为不可用（继续尝试下一个）——避免把「读不到日志」变成
 * 异常打断调用方。
 * @param {Array<() => unknown>} getters - 按优先级排列的取值器。
 * @returns {Array | undefined} 第一个数组结果；都没有则 undefined。
 */
function firstEventArray(getters) {
  for (const get of getters) {
    try {
      const value = get()
      if (Array.isArray(value)) return value
    } catch {
      /* 该取值器不可用 → 尝试下一个 */
    }
  }
  return undefined
}

/**
 * 读会话「全量日志」——旧 `agent.session.events` 的等价替换。
 * 取值顺序：`snapshotEvents()` → `ownEvents()` → 遗留 `.events`。
 * @param {object | undefined} agentOrSession - agent（`{ session }`）或 session。
 * @returns {Array | undefined} 事件数组；读不到返回 **undefined**（不是 `[]`）。
 */
export function readSessionLog(agentOrSession) {
  const session = resolveSession(agentOrSession)
  if (!session) return undefined
  return firstEventArray([
    () => session.snapshotEvents?.(),
    () => session.ownEvents?.(),
    () => session.events,
  ])
}

/**
 * 读会话「fork 局部视图」日志（本会话自己拥有的事件，用于分支/锚点类场景）。
 * 取值顺序：`ownEvents()` → `snapshotEvents()` → 遗留 `.events`。
 * @param {object | undefined} agentOrSession - agent（`{ session }`）或 session。
 * @returns {Array | undefined} 事件数组；读不到返回 **undefined**（不是 `[]`）。
 */
export function readOwnSessionLog(agentOrSession) {
  const session = resolveSession(agentOrSession)
  if (!session) return undefined
  return firstEventArray([
    () => session.ownEvents?.(),
    () => session.snapshotEvents?.(),
    () => session.events,
  ])
}
