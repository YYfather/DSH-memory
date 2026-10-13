/**
 * dsh-memory-evolve — 远端检测超时预算测试（PR #91 后半，lib/update.js）。
 *
 * 背景：远端版本检测跑 `git ls-remote --tags origin`，实测常态 8–17s；旧实现
 * 沿用 8s 的**本地**命令预算（CHECK_TIMEOUT_MS），导致检测间歇性失败，界面报
 * 「远端检测失败（error）」。修复：新增 30s 网络预算 REMOTE_TIMEOUT_MS（与
 * lib/sync/repo.js 的 NETWORK_TIMEOUT_MS 对齐），且 ls-remote 必须真的用它。
 *
 * 本套用例用注入的 run 探针断言「哪条命令拿到哪个预算」——比断言常量更能防
 * 回归（有人把 ls-remote 改回默认预算时立刻失败）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUpdateChecker, REMOTE_TIMEOUT_MS } from '../lib/update.js'
import { NETWORK_TIMEOUT_MS } from '../lib/sync/repo.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-update-timeout-'))
}

test('REMOTE_TIMEOUT_MS：30s 网络预算，与 sync 的 NETWORK_TIMEOUT_MS 对齐', () => {
  assert.equal(REMOTE_TIMEOUT_MS, 30_000)
  assert.equal(REMOTE_TIMEOUT_MS, NETWORK_TIMEOUT_MS)
  assert.ok(REMOTE_TIMEOUT_MS > 8000, '必须大于旧的本地 8s 预算')
})

test('doCheck：ls-remote 走 30s 网络预算，本地命令仍走 8s 预算', async (t) => {
  const dir = tempDir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const gitDir = join(dir, 'gitdir')

  /** 注入的 run 探针：记录每条命令的 args + timeout。 */
  const seen = []
  const run = async (cmd, args, opts) => {
    seen.push({ line: args.join(' '), timeout: opts?.timeout })
    if (args[0] === 'rev-parse') return { stdout: `${gitDir}\n`, stderr: '' }
    if (args[0] === 'config') return { stdout: 'https://example.invalid/repo.git\n', stderr: '' }
    return { stdout: '', stderr: '' } // ls-remote / describe 等
  }

  const checker = createUpdateChecker({ repoDir: dir, fallbackDir: dir, run, now: () => 1_700_000_000_000 })
  const result = await checker._internal.doCheck()
  assert.equal(result.ok, true) // 探针让链路走通（无发布 tag → no-release）

  const lsRemote = seen.find((entry) => entry.line.startsWith('ls-remote'))
  assert.ok(lsRemote, '必须真的执行了 ls-remote')
  assert.equal(lsRemote.timeout, REMOTE_TIMEOUT_MS)
  assert.equal(lsRemote.timeout, 30_000)

  // 本地命令（rev-parse/config/describe）保持本地预算，不被网络预算污染
  const local = seen.filter((entry) => entry.line.startsWith('rev-parse') || entry.line.startsWith('config'))
  assert.ok(local.length > 0)
  for (const entry of local) {
    assert.equal(entry.timeout, 8000, `${entry.line} 应使用本地 8s 预算`)
  }
})

test('doCheck：ls-remote 超时（30s 用尽）→ kind=timeout 且如实落 lastError', async (t) => {
  const dir = tempDir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const gitDir = join(dir, 'gitdir')

  const seen = []
  const run = async (cmd, args, opts) => {
    seen.push({ line: args.join(' '), timeout: opts?.timeout })
    if (args[0] === 'rev-parse') return { stdout: `${gitDir}\n`, stderr: '' }
    if (args[0] === 'config') return { stdout: 'https://example.invalid/repo.git\n', stderr: '' }
    // 模拟 runGit 的超时分支：killed 标记
    const err = new Error('timed out')
    err.killed = true
    throw err
  }

  const checker = createUpdateChecker({ repoDir: dir, fallbackDir: dir, run, now: () => 1_700_000_000_000 })
  const result = await checker._internal.doCheck()
  assert.equal(result.ok, false)
  assert.equal(result.state.lastError.kind, 'timeout')
  assert.equal(seen.find((entry) => entry.line.startsWith('ls-remote')).timeout, REMOTE_TIMEOUT_MS)
})
