/**
 * dsh-memory-evolve — 同源保护「无 Origin」放行测试（PR #91，桌面端 DSH）。
 *
 * DSH 桌面端宿主转发 Web UI 请求时**不带 Origin**，旧实现一律拒绝 → 桌面端
 * 「更新」按钮恒 400、advisor 全部写接口恒 403。新契约：
 *   - Origin 存在：仍必须与 Host 同源（跨站一律仍拒，不放宽）；
 *   - Origin 缺失：只信任回环对端（socket remoteAddress）或回环 Host；
 *     两者都没有（进程内合成请求）放行；非回环拒绝并保留原文案。
 *
 * 两处本地副本（lib/api.js、lib/advisor/api.js）都走 lib/origin-guard.js 的共用
 * 判定——本套用例既单测该判定，也经真实 HTTP + 合成请求打到两个 guard 本身。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allowAbsentOrigin, isLoopbackAddress, isLoopbackHost } from '../lib/origin-guard.js'
import { installApi } from '../lib/api.js'
import { installAdvisorApi } from '../lib/advisor/api.js'
import { ArchiveStore, MemoryStore, SuggestionQueue } from '../lib/store.js'
import { TodoStore } from '../lib/todo.js'

// 与 tests/api.test.js 同款：钉住中文文案契约。
import { setLocale } from '../lib/i18n.js'
setLocale('zh')

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-origin-guard-'))
}

/** 合成响应对象（记录 status/body）。 */
function makeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(text) { this.body = String(text ?? '') },
    json() { return this.body === '' ? {} : JSON.parse(this.body) },
  }
}

/**
 * 合成请求对象（可指定 socket 对端、Host、Origin）。
 * body 走异步迭代器——与 node http 请求对象的消费方式一致。
 */
function makeReq({ path, method = 'POST', headers = {}, socket, dropHost = false, body } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const merged = { 'content-type': 'application/json' }
  if (!dropHost) merged.host = '127.0.0.1:3000'
  if (payload !== '') merged['content-length'] = String(Buffer.byteLength(payload))
  Object.assign(merged, headers)
  return {
    method,
    url: path,
    headers: merged,
    ...(socket === undefined ? {} : { socket: { remoteAddress: socket } }),
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload)
    },
  }
}

// ---------------------------------------------------------------------------
// 共用判定（lib/origin-guard.js）
// ---------------------------------------------------------------------------

test('isLoopbackAddress：127.x / ::1 / ::ffff:127.x 都算回环，其余不算', () => {
  for (const addr of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::ffff:127.9.9.9']) {
    assert.equal(isLoopbackAddress(addr), true, `${addr} 应为回环`)
  }
  for (const addr of ['10.0.0.5', '192.168.1.7', '::ffff:10.0.0.5', 'fe80::1', '', undefined, null]) {
    assert.equal(isLoopbackAddress(addr), false, `${addr} 不应为回环`)
  }
})

test('isLoopbackHost：127.0.0.1[:port] / localhost[:port] / [::1][:port] 才放行', () => {
  for (const host of ['127.0.0.1', '127.0.0.1:3000', 'localhost', 'localhost:8080', '[::1]', '[::1]:19387']) {
    assert.equal(isLoopbackHost(host), true, `${host} 应为回环主机`)
  }
  for (const host of ['evil.example.com', 'evil.example.com:80', '10.0.0.5:3000', '', undefined]) {
    assert.equal(isLoopbackHost(host), false, `${host} 不应为回环主机`)
  }
})

test('allowAbsentOrigin：回环 socket 放行；非回环 socket 拒绝（Host 回环也不救）', () => {
  assert.equal(allowAbsentOrigin(makeReq({ path: '/x', socket: '127.0.0.1', body: {} })), true)
  assert.equal(allowAbsentOrigin(makeReq({ path: '/x', socket: '::ffff:127.0.0.1', body: {} })), true)
  assert.equal(allowAbsentOrigin(makeReq({ path: '/x', socket: '::1', body: {} })), true)
  assert.equal(allowAbsentOrigin(makeReq({ path: '/x', socket: '10.0.0.5', body: {} })), false)
  // 非回环对端 + 回环 Host：仍按对端判定拒绝（Host 头可伪造，不能反超 socket）
  assert.equal(allowAbsentOrigin(makeReq({ path: '/x', socket: '10.0.0.5', headers: { host: '127.0.0.1:3000' }, body: {} })), false)
})

test('allowAbsentOrigin：无 socket 信息时看 Host；连 Host 都没有（进程内合成）放行', () => {
  assert.equal(allowAbsentOrigin(makeReq({ path: '/x', body: {} })), true) // 默认 host=127.0.0.1:3000
  assert.equal(allowAbsentOrigin(makeReq({ path: '/x', headers: { host: 'localhost:3000' }, body: {} })), true)
  assert.equal(allowAbsentOrigin(makeReq({ path: '/x', headers: { host: '[::1]:3000' }, body: {} })), true)
  assert.equal(allowAbsentOrigin(makeReq({ path: '/x', headers: { host: 'evil.example.com' }, body: {} })), false)
  assert.equal(allowAbsentOrigin(makeReq({ path: '/x', dropHost: true, body: {} })), true)
})

// ---------------------------------------------------------------------------
// lib/api.js：POST /memory-evolve/api/update
// ---------------------------------------------------------------------------

/** 装配 lib/api.js 的 handler（updateOps 为桩：只记录是否被放行调用）。 */
function bootUpdateApi() {
  const dir = tempDir()
  const state = { todoEnabled: true }
  const calls = []
  const ctx = {
    webServer: {
      register: ({ handler }) => {
        ctx.handler = handler
        return () => {}
      },
    },
  }
  installApi(ctx, {
    store: new MemoryStore(dir),
    archive: new ArchiveStore(dir),
    queue: new SuggestionQueue(join(dir, 'SUGGESTIONS.jsonl')),
    todoStore: new TodoStore(dir),
    getRuntime: () => ({ ...state }),
    updateRuntime: (patch) => Object.assign(state, patch),
    config: { memoryDir: dir, skillDir: join(dir, 'skills') },
    updateOps: {
      update: async (tag) => {
        calls.push(tag)
        return { ok: true, tag, sha: 'a'.repeat(40), releaseNotes: '', restartRequired: false }
      },
    },
  })
  return { dir, ctx, calls, close: () => rmSync(dir, { recursive: true, force: true }) }
}

const UPDATE_PATH = '/memory-evolve/api/update'
const UPDATE_BODY = { expectedTag: 'v1.0.0' }

test('api 更新端点：缺 Origin + 回环 socket → 放行（桌面宿主转发）', async (t) => {
  const api = bootUpdateApi()
  t.after(() => api.close())

  const res = makeRes()
  await api.ctx.handler(makeReq({ path: UPDATE_PATH, socket: '::ffff:127.0.0.1', body: UPDATE_BODY }), res)
  assert.equal(res.status, 200)
  assert.equal(res.json().ok, true)
  assert.deepEqual(api.calls, ['v1.0.0'])
})

test('api 更新端点：缺 Origin + 非回环 socket → 仍拒绝（原文案）', async (t) => {
  const api = bootUpdateApi()
  t.after(() => api.close())

  const res = makeRes()
  await api.ctx.handler(makeReq({ path: UPDATE_PATH, socket: '10.0.0.5', headers: { host: '127.0.0.1:3000' }, body: UPDATE_BODY }), res)
  assert.equal(res.status, 400)
  assert.match(res.json().error, /缺少 Origin 头/)
  assert.deepEqual(api.calls, []) // guard 在写操作之前拦截
})

test('api 更新端点：缺 Origin + 只有回环 Host → 放行', async (t) => {
  const api = bootUpdateApi()
  t.after(() => api.close())

  for (const host of ['127.0.0.1:3000', 'localhost:3000', '[::1]:3000']) {
    const res = makeRes()
    await api.ctx.handler(makeReq({ path: UPDATE_PATH, headers: { host }, body: UPDATE_BODY }), res)
    assert.equal(res.status, 200, `${host} 应放行`)
  }
  // 非回环 Host + 无 socket 信息 → 拒绝
  const bad = makeRes()
  await api.ctx.handler(makeReq({ path: UPDATE_PATH, headers: { host: 'evil.example.com' }, body: UPDATE_BODY }), bad)
  assert.equal(bad.status, 400)
  assert.match(bad.json().error, /缺少 Origin 头/)
})

test('api 更新端点：带 Origin 时语义不变——同源放行、跨站仍拒绝', async (t) => {
  const api = bootUpdateApi()
  t.after(() => api.close())

  const same = makeRes()
  await api.ctx.handler(makeReq({
    path: UPDATE_PATH, socket: '127.0.0.1',
    headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
    body: UPDATE_BODY,
  }), same)
  assert.equal(same.status, 200)

  const cross = makeRes()
  await api.ctx.handler(makeReq({
    path: UPDATE_PATH, socket: '127.0.0.1',
    headers: { host: '127.0.0.1:3000', origin: 'http://evil.example.com' },
    body: UPDATE_BODY,
  }), cross)
  assert.equal(cross.status, 400)
  assert.match(cross.json().error, /跨站请求已拒绝/)
  assert.deepEqual(api.calls, ['v1.0.0']) // 只有同源那次被放行
})

test('api 更新端点：真实 HTTP 回环连接（无 Origin）→ 200（桌面端场景复现）', async (t) => {
  const api = bootUpdateApi()
  t.after(() => api.close())
  const server = createServer((req, res) => api.ctx.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const res = await fetch(`http://127.0.0.1:${server.address().port}${UPDATE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(UPDATE_BODY),
  })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).ok, true)
})

// ---------------------------------------------------------------------------
// lib/advisor/api.js：POST /memory-evolve/api/advisor/toggle
// ---------------------------------------------------------------------------

/** 装配 advisor API（ctrl 为桩：只关心 guard 是否放行）。 */
function bootAdvisorApi() {
  const ctx = {
    webServer: {
      register: ({ handler }) => {
        ctx.handler = handler
        return () => {}
      },
    },
  }
  const ctrl = {
    sessionExists: (id) => id === 's1',
    setSessionOverride: (id, enabled) => ({ sessionId: id, enabled }),
  }
  installAdvisorApi(ctx, ctrl)
  return ctx
}

const TOGGLE_PATH = '/memory-evolve/api/advisor/toggle'
const TOGGLE_BODY = { sessionId: 's1', enabled: true }

test('advisor 写端点：缺 Origin + 回环 socket → 放行（原 403）', async () => {
  const ctx = bootAdvisorApi()
  const res = makeRes()
  await ctx.handler(makeReq({ path: TOGGLE_PATH, socket: '127.0.0.1', body: TOGGLE_BODY }), res)
  assert.equal(res.status, 200)
  assert.equal(res.json().ok, true)
})

test('advisor 写端点：缺 Origin + 非回环 socket → 仍 403（原文案）', async () => {
  const ctx = bootAdvisorApi()
  const res = makeRes()
  await ctx.handler(makeReq({ path: TOGGLE_PATH, socket: '192.168.1.7', body: TOGGLE_BODY }), res)
  assert.equal(res.status, 403)
  assert.equal(res.json().code, 'FORBIDDEN')
  assert.match(res.json().error, /缺少 Origin 头/)
})

test('advisor 写端点：缺 Origin + 只有回环 Host → 放行；带跨站 Origin → 仍 403', async () => {
  const ctx = bootAdvisorApi()
  const ok = makeRes()
  await ctx.handler(makeReq({ path: TOGGLE_PATH, headers: { host: 'localhost:19387' }, body: TOGGLE_BODY }), ok)
  assert.equal(ok.status, 200)

  const cross = makeRes()
  await ctx.handler(makeReq({
    path: TOGGLE_PATH, socket: '127.0.0.1',
    headers: { host: '127.0.0.1:3000', origin: 'http://evil.example.com' },
    body: TOGGLE_BODY,
  }), cross)
  assert.equal(cross.status, 403)
  assert.match(cross.json().error, /跨站请求已拒绝/)
})
