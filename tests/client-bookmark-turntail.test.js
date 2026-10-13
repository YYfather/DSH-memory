/**
 * 轮尾书签注入器的跨版本定位护栏（2026-10-13，issue #86 / DSH 0.2.0 适配）。
 *
 * 背景：DSH 0.2.x 把消息操作区（含 Branch 按钮）从 `assistant-step` 消息节点
 * **内部**搬到了独立的轮尾节点 `div[data-turn-tail]`（ui-chat 的 TurnTailNodeView，
 * `data-turn-tail` = 轮次号）。旧实现只在消息节点内部找 Branch 按钮，于是
 * 「节点内有 Branch 按钮」这条判据在 0.2.x 上**恒为假**，☆ 星标一个都注入不出去
 * （书签功能整体不可用，但 Tab 与数据层都正常，所以只在"打不了星"时暴露）。
 *
 * 这组测试钉住三件事：
 *   1) 0.2.x 路径存在：以 `[data-turn-tail]` 为准找操作区；
 *   2) 锚点不再依赖"按钮在消息节点内"：轮尾节点自身没有
 *      `data-chat-anchor-key`，必须往上找该轮最近的消息锚点；
 *   3) 老宿主（≤0.1.x）路径保留，不因适配新宿主而回归。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INJECTOR = join(ROOT, 'src/client/bookmark-injector.tsx')
const source = readFileSync(INJECTOR, 'utf8')

test('the injector targets the 0.2.x turn-tail node, not only the message node', () => {
  assert.match(source, /querySelectorAll<HTMLElement>\('\[data-turn-tail\]'\)/u, 'must query [data-turn-tail] (0.2.x action bar host)')
  assert.match(source, /turnOfTail/u, 'must read the turn number from data-turn-tail')
  assert.match(source, /resolveTurnAnchor/u, 'must resolve the message anchor of a turn tail')
})

test('the anchor is resolved by document order, not by "branch button lives inside the message node"', () => {
  // 轮尾节点没有 data-chat-anchor-key，只能按文档顺序往上找。
  assert.match(
    source,
    /compareDocumentPosition\(node\)\s*&\s*Node\.DOCUMENT_POSITION_PRECEDING/u,
    'the nearest preceding [data-chat-anchor-key] is the turn\'s closing message',
  )
})

test('a turn ending in a tool call still gets a star (anchor prefers the turn\'s assistant-step)', () => {
  // 一轮的最后一条 surface 节点可能是 call/tool-result 独立节点（锚点形如 call:<id>），
  // 直接取"最近锚点"会拿到 call 锚点；必须优先取同轮 assistant-step，并保留兜底。
  assert.match(source, /parsed\.kind !== 'assistant-step'/u, 'non-assistant anchors must not win over the closing assistant message')
  assert.match(source, /fallback \?\?= \{ node, parsed \}/u, 'a non-assistant anchor must remain as a last-resort fallback')
  assert.match(source, /nodeTurn !== turn/u, 'the assistant-step must be confirmed to belong to the tail\'s turn')
})

test('both host generations keep working (0.2.x turn-tail path + legacy in-node path)', () => {
  // 0.2.x：动作宿主与锚点元素是两个不同的节点。
  assert.match(source, /enableForkOnTurn\(tail,\s*anchor,\s*turn\)/u, 'the 0.2.x path must pass the tail as action host and the anchor separately')
  // 老宿主：动作区仍在消息节点内部，宿主与锚点是同一个节点。
  assert.match(source, /enableForkOnTurn\(node,\s*node,\s*null\)/u, 'the legacy path must stay wired')
  // 老宿主没有 [data-turn-tail] 时要走回退分支。
  assert.match(source, /if \(tails\.length > 0\)/u, 'the turn-tail path must be preferred only when turn-tail nodes exist')
})

test('mid-turn fork takeover still works and only the tail gets a star', () => {
  // 中间轮：官方 aria-disabled="true" → 接管但不打星。
  assert.match(source, /aria-disabled/u, 'branchUnavailable is expressed as aria-disabled="true"')
  assert.match(source, /data-unavailable/u, 'the official disabled-state attribute must be cleared when taking over')
  // 星标只注入给"分支可用"的轮尾。
  assert.match(source, /function findTailBranch/u, 'the tail-only star predicate must remain')
})

test('built bundle carries the turn-tail path (rebuild after editing src/client)', () => {
  const bundle = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  assert.ok(bundle.includes('data-turn-tail'), 'lib/client.js must query [data-turn-tail]')
  assert.ok(bundle.includes('resolveTurnAnchor'), 'the document-order anchor resolver must survive bundling')
})
