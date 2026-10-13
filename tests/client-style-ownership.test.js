/**
 * 客户端 `<style>` 归属护栏（2026-10-13，issue #89 / DSH 0.2.0 适配）。
 *
 * 背景：DSH 的 `dsh-client-modules` 用 `<style>` 上的 `data-plugin` 维护样式
 * 归属账本——物化任一插件后 `claimStyles(id)` 会**认领页面上所有没有归属的
 * `<style>`**，该插件重载/回收时再按归属把它们删掉。本插件的样式是在
 * `apply()` 阶段注入的（晚于自身 bundle 物化），若不带归属就会：
 *   ① 被随后物化的任意插件认领 → 对方一重载就把我们的样式删掉，且注入守卫
 *      认为"已注入"永不恢复（面板裸奔）；
 *   ② 反过来，本插件物化时把页面上**所有**孤儿标签认领到自己名下 → 本插件
 *      一重载就删掉**别人**的样式（整页掉样式，DOM 完好但没有 CSS）。
 *
 * 这组测试做四道静态护栏：
 *   1) `src/client` 下只有 `style-tag.ts` 允许创建 `<style>`；
 *   2) 全部样式注入点都经 `injectOwnedStyle`（逐个标记不许漏）；
 *   3) 归属键必须等于包名（= Loader 条目 id，账本用的 ownerId）；
 *   4) 构建产物里确实带上了归属属性（防"改了源码没重建"）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SRC = join(ROOT, 'src/client')
const STYLE_TAG = join(CLIENT_SRC, 'style-tag.ts')

/** 历史上已存在的样式标记：少一个就意味着某段样式没注入（或又被散落回去）。 */
const EXPECTED_MARKERS = [
  'data-memory-evolve-css',
  'data-skill-browser-css',
  'data-coi-css',
  'data-broadcast-css',
  'data-prompt-css',
  'data-ui-settings-css',
  'data-me-mermaid-css',
  'data-bookmark-css',
  'data-advisor-css',
  'data-notify-css',
]

/** 递归收集一个目录下的所有文件（绝对路径）。 */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const SOURCES = walk(CLIENT_SRC)
const TS_SOURCES = SOURCES.filter((file) => /\.tsx?$/u.test(file))

test('only style-tag.ts creates <style> tags', () => {
  const offenders = TS_SOURCES
    .filter((file) => file !== STYLE_TAG)
    .filter((file) => /createElement\(\s*['"]style['"]\s*\)/u.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(ROOT.length + 1))
  assert.deepEqual(
    offenders,
    [],
    'inject styles through injectOwnedStyle() in style-tag.ts, otherwise the tag is an unowned orphan and gets stolen by the next materialized plugin',
  )
})

test('every panel stylesheet still goes through injectOwnedStyle', () => {
  const index = readFileSync(join(CLIENT_SRC, 'index.ts'), 'utf8')
  const markers = [...index.matchAll(/injectOwnedStyle\(\s*'([^']+)'/gu)].map((m) => m[1])
  assert.deepEqual(
    [...markers].sort(),
    [...EXPECTED_MARKERS].sort(),
    'the memory-evolve entry must inject exactly these stylesheets, each with its own marker',
  )
  // 画板是自包含子目录，标记走 constants.ts 的常量。
  const canvas = readFileSync(join(CLIENT_SRC, 'canvas-grok/index.ts'), 'utf8')
  assert.match(canvas, /injectOwnedStyle\(\s*STYLE_ATTR\s*,/u, 'the canvas stylesheet must use the shared ownership entry')
  const constants = readFileSync(join(CLIENT_SRC, 'canvas-grok/constants.ts'), 'utf8')
  assert.match(constants, /STYLE_ATTR\s*=\s*'data-cg-canvas-css'/u, 'the canvas style marker must stay data-cg-canvas-css')
})

test('the ownership key equals the package name (the style ledger ownerId)', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const shim = readFileSync(STYLE_TAG, 'utf8')
  const declared = /PLUGIN_ID\s*=\s*'([^']+)'/u.exec(shim)?.[1]
  assert.equal(
    declared,
    manifest.name,
    'data-plugin must be the package name: claimStyles/removeOwnedStyles key the ledger by the loader entry id',
  )
  assert.match(shim, /setAttribute\(PLUGIN_OWNER_ATTR,\s*PLUGIN_ID\)/u, 'the tag must be stamped at creation time')
  // 幂等守卫分支也要抢回归属（修复升级前遗留的孤儿标签）。
  assert.match(
    shim,
    /existing\.getAttribute\(PLUGIN_OWNER_ATTR\)\s*!==\s*PLUGIN_ID\)\s*\{[\s\S]{0,160}?setAttribute\(PLUGIN_OWNER_ATTR,\s*PLUGIN_ID\)/u,
    'the existing-tag guard must also reclaim ownership',
  )
})

test('built bundle stamps data-plugin ownership (rebuild after editing src/client)', () => {
  const bundle = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  assert.ok(bundle.includes('data-plugin'), 'lib/client.js must set data-plugin on injected style tags')
  assert.ok(bundle.includes('PLUGIN_ID'), 'the ownership constant must survive bundling')
  // 产物里不应再有裸的 createElement("style") 注入点（只应出现在 style-tag 的实现里）。
  const tagCreates = bundle.match(/createElement\("style"\)/gu) ?? []
  assert.equal(tagCreates.length, 1, `expected exactly one style-tag factory in the bundle, saw ${tagCreates.length}`)
})
