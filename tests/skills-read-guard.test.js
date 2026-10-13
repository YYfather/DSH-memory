/**
 * dsh-memory-evolve — skill_manage「先读后写」证据守卫测试（issue #90）。
 *
 * hasReadSkill 有两个缺陷（0.2.0-rc.2 上 patch 永久不可用，恒提示「必须先读」）：
 *   a) 读 `session.events`——0.2.x 已移除该属性 → 恒 undefined → 恒 false；
 *   b) `event.data.arguments` 可能已是**对象**，`JSON.parse(对象)` 抛错并被
 *      静默吞掉 → 有读证据也判不出来。
 * 本套用例同时钉住两种 arguments 形状、只有 snapshotEvents 的 0.2.x 会话
 * 形状，以及未读/畸形输入的非抛错行为。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasReadSkill } from '../lib/skills.js'

const TOOL = 'skill_manage'

/** 0.2.x 真身形状：只有 snapshotEvents()，没有 `.events` 属性。 */
function session0x(events) {
  return { snapshotEvents: () => events }
}

/** 一条 tool/call 事件。 */
function toolCall(argumentsValue, name = TOOL) {
  return { type: 'tool/call', data: { name, arguments: argumentsValue } }
}

test('hasReadSkill：arguments 是 JSON 字符串 → 已读为真', () => {
  const agent = { session: session0x([toolCall(JSON.stringify({ action: 'read', name: 'alpha' }))]) }
  assert.equal(hasReadSkill(agent, TOOL, 'alpha'), true)
})

test('hasReadSkill：arguments 已是对象 → 同样判为已读（issue #90 缺陷 b）', () => {
  const agent = { session: session0x([toolCall({ action: 'read', name: 'alpha' })]) }
  assert.equal(hasReadSkill(agent, TOOL, 'alpha'), true)
})

test('hasReadSkill：只有 snapshotEvents 的 0.2.x 会话也可判定（issue #90 缺陷 a）', () => {
  const agent = { session: session0x([toolCall({ action: 'read', name: 'beta' })]) }
  // 会话对象上确实没有 .events（回归保护：不能再依赖该属性）
  assert.equal('events' in agent.session, false)
  assert.equal(hasReadSkill(agent, TOOL, 'beta'), true)
})

test('hasReadSkill：未读过 → false（读别的技能/别的动作/别的工具都不算）', () => {
  const events = [
    toolCall(JSON.stringify({ action: 'read', name: 'other' })),
    toolCall(JSON.stringify({ action: 'patch', name: 'alpha' })),
    toolCall(JSON.stringify({ action: 'read', name: 'alpha' }), 'other_tool'),
    { type: 'assistant/message', data: { name: TOOL, arguments: JSON.stringify({ action: 'read', name: 'alpha' }) } },
  ]
  assert.equal(hasReadSkill({ session: session0x(events) }, TOOL, 'alpha'), false)
})

test('hasReadSkill：日志不可读 / agent 缺失 → false，不抛错', () => {
  assert.equal(hasReadSkill(undefined, TOOL, 'alpha'), false)
  assert.equal(hasReadSkill({}, TOOL, 'alpha'), false)
  assert.equal(hasReadSkill({ session: {} }, TOOL, 'alpha'), false)
  // 合法空日志同样是 false（但走的是「无证据」分支，不报错）
  assert.equal(hasReadSkill({ session: session0x([]) }, TOOL, 'alpha'), false)
})

test('hasReadSkill：arguments 畸形（非法 JSON / 缺失 / 非对象）不抛错，仅跳过', () => {
  const events = [
    toolCall('{ not json'),
    toolCall(undefined),
    toolCall(null),
    toolCall(42),
    toolCall(['action', 'read']),
    toolCall({ action: 'read', name: 'alpha' }), // 最后一条才是有效证据
  ]
  assert.equal(hasReadSkill({ session: session0x(events) }, TOOL, 'alpha'), true)
  // 畸形输入单独出现时判 false（且不抛）
  assert.equal(hasReadSkill({ session: session0x([toolCall('{ not json')]) }, TOOL, 'alpha'), false)
  assert.equal(hasReadSkill({ session: session0x([toolCall(undefined)]) }, TOOL, 'alpha'), false)
})

test('hasReadSkill：老宿主只剩 legacy .events 时仍可判定（向下兼容）', () => {
  const agent = { session: { events: [toolCall(JSON.stringify({ action: 'read', name: 'alpha' }))] } }
  assert.equal(hasReadSkill(agent, TOOL, 'alpha'), true)
})
