/**
 * DSH 客户端 `<style>` 注入的**归属工具**（2026-10-13，issue #89 / DSH 0.2.0 适配）。
 *
 * ## 为什么必须写 `data-plugin`
 * DSH 的 `@deepseek-ai/dsh-client-modules` 用 `<style>` 上的 `data-plugin`
 * 维护一张样式归属账本：
 *
 *   - 物化（materialize）任一插件 bundle 后立即 `claimStyles(id)`，而它的实现是
 *     `document.querySelectorAll('style:not([data-plugin])')` ——
 *     **认领页面上所有没有归属的 `<style>`**；
 *   - 该插件被 HMR 重载 / 图重组回收时 `removeOwnedStyles(id)` 按归属删除。
 *
 * 本插件的样式是在 `apply()` 阶段注入的，**晚于**自己那次 bundle 物化，
 * 因此如果不写归属，它们就是「孤儿标签」：
 *
 *   1. 被**随后物化的任意插件**认领走 → 那个插件一重载/回收，本插件的样式
 *      被连带删除，而且注入守卫（`style[data-…]` 已存在）认为"注入过了"、
 *      **永不恢复** → 面板裸奔；
 *   2. 反过来，本插件物化时 `claimStyles` 会把页面上**所有**孤儿标签认领到
 *      本插件名下 → 本插件一重载就把**别人的**样式一起删掉（整页掉样式，
 *      DOM 完好但没有任何 CSS —— 用户看到的就是"界面变成裸控件"）。
 *
 * 官方客户端插件（ui-layout / ui-conversation / ui-theme …）之所以安全，是因为
 * 它们在注入时就自己写了归属。本模块把这件事收敛成**唯一入口**，避免以后
 * 新增注入点又漏打（仓库有静态护栏测试扫源码与产物）。
 *
 * 归属键必须等于**包名**，也就是 Loader 条目 id —— `claimStyles`/`removeOwnedStyles`
 * 用的 ownerId 就是它（`materialize(id, ownerId = id)`）。
 *
 * @module dsh-memory-evolve/style-tag
 */

/** 本插件的 Loader 条目 id / 包名，即样式账本的归属键。 */
export const PLUGIN_ID = '@yyfather/dsh-memory'

/** 样式账本读取的归属属性名。 */
export const PLUGIN_OWNER_ATTR = 'data-plugin'

/**
 * 注入一段带归属的插件样式（幂等：同一 `marker` 只注入一次）。
 *
 * 已存在同 `marker` 的标签时**不重复注入**，但会顺手把归属抢回来：
 * 历史遗留的孤儿标签可能已被别的插件认领，补写归属即可让它不再被连带删除
 * （修复升级前的存量页面，无需用户手动刷新两次）。
 *
 * @param marker - 本段样式专用的标记属性名，如 `'data-memory-evolve-css'`。
 * @param css - 样式文本（由构建期的 text loader 从 `.css` 内联而来）。
 * @returns 卸载句柄：移除本次注入的标签（已存在时为空操作）。
 */
export function injectOwnedStyle(marker: string, css: string): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector<HTMLStyleElement>(`style[${marker}]`)
  if (existing !== null) {
    if (existing.getAttribute(PLUGIN_OWNER_ATTR) !== PLUGIN_ID) {
      existing.setAttribute(PLUGIN_OWNER_ATTR, PLUGIN_ID)
    }
    return () => {}
  }
  const tag = document.createElement('style')
  // 归属必须与创建同时落定：晚一步就可能被别的插件物化时认领走。
  tag.setAttribute(PLUGIN_OWNER_ATTR, PLUGIN_ID)
  tag.setAttribute(marker, '1')
  tag.textContent = css
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
