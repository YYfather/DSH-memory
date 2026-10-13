/**
 * dsh-memory-evolve — 会话事件日志兼容层测试（lib/session-events.js）。
 *
 * 覆盖 DSH 0.2.x 适配（issue #90 的根因层）：
 *   - readSessionLog 优先 snapshotEvents()，回退 ownEvents() → 遗留 .events；
 *   - readOwnSessionLog 优先 ownEvents()（fork 局部视图），回退 snapshotEvents()；
 *   - 都不可用时返回 **undefined**（不是 []）——调用方据此区分「会话不在本
 *     进程/日志不可读」与「日志为空」；
 *   - 入参既接受 agent（{ session }）也接受 session 本身；取值器抛错视为
 *     该取值器不可用，继续兜底而不是把「读不到」升级成异常。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readSessionLog, readOwnSessionLog } from '../lib/session-events.js'

/** 事件夹具（形状无关，只验证取自哪一路取值器）。 */
const A = [{ type: 'a', seq: 1 }]
const B = [{ type: 'b', seq: 2 }]
const C = [{ type: 'c', seq: 3 }]

test('readSessionLog：优先 snapshotEvents（0.2.x 的真身形状：只有 snapshotEvents）', () => {
  const session = { snapshotEvents: () => A }
  assert.equal(readSessionLog({ session }), A)
})

test('readSessionLog：三路都在时按 snapshotEvents → ownEvents → .events 取第一路', () => {
  const session = {
    snapshotEvents: () => A,
    ownEvents: () => B,
    events: C,
  }
  assert.equal(readSessionLog({ session }), A)
})

test('readSessionLog：无 snapshotEvents 时回退 ownEvents', () => {
  const session = { ownEvents: () => B, events: C }
  assert.equal(readSessionLog({ session }), B)
})

test('readSessionLog：老宿主只剩 .events 仍可读', () => {
  const session = { events: C }
  assert.equal(readSessionLog({ session }), C)
})

test('readSessionLog：读不到返回 undefined（不是空数组）', () => {
  assert.equal(readSessionLog({ session: {} }), undefined)
  assert.equal(readSessionLog({}), undefined)
  assert.equal(readSessionLog(undefined), undefined)
  assert.equal(readSessionLog(null), undefined)
  // 取值器返回非数组（undefined/null/对象）一律不算「可读」
  assert.equal(readSessionLog({ session: { snapshotEvents: () => undefined, ownEvents: () => null, events: {} } }), undefined)
  // 合法的空日志是数组 → 返回 []（与「读不到」区分）
  assert.deepEqual(readSessionLog({ session: { snapshotEvents: () => [] } }), [])
})

test('readSessionLog：直接传 session 本身（不套 agent）也可用', () => {
  assert.equal(readSessionLog({ snapshotEvents: () => A }), A)
  // agent 的 session 为假值时回退到 agent 本身（防御性：不改变契约）
  assert.equal(readSessionLog({ session: undefined, snapshotEvents: () => A }), A)
})

test('readSessionLog：取值器抛错视为不可用，继续走后续兜底（不向外抛）', () => {
  const session = {
    snapshotEvents: () => { throw new Error('boom') },
    ownEvents: () => B,
    events: C,
  }
  assert.equal(readSessionLog({ session }), B)
  // 三路全抛 → undefined（依旧不抛）
  const allBad = {
    snapshotEvents: () => { throw new Error('boom') },
    ownEvents: () => { throw new Error('boom') },
  }
  assert.equal(readSessionLog({ session: allBad }), undefined)
})

test('readOwnSessionLog：优先 ownEvents（fork 局部视图）', () => {
  const session = { ownEvents: () => B, snapshotEvents: () => A, events: C }
  assert.equal(readOwnSessionLog({ session }), B)
})

test('readOwnSessionLog：无 ownEvents 时回退 snapshotEvents，再回退 .events', () => {
  assert.equal(readOwnSessionLog({ session: { snapshotEvents: () => A, events: C } }), A)
  assert.equal(readOwnSessionLog({ session: { events: C } }), C)
})

test('readOwnSessionLog：读不到同样返回 undefined', () => {
  assert.equal(readOwnSessionLog({ session: {} }), undefined)
  assert.equal(readOwnSessionLog(undefined), undefined)
})
