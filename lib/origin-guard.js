/**
 * 同源保护共用判定：**无 Origin 头**的请求是否可放行（DSH 桌面端适配）。
 *
 * 背景（PR #91）：DSH **桌面端**把 Web UI 的请求转发到插件路由时**不携带
 * Origin 头**，而旧实现在 `origin === ''` 时一律拒绝——桌面端点「更新」按钮
 * 恒返回 HTTP 400，advisor 的全部写接口恒返回 403。
 *
 * 放宽范围**仅限「Origin 缺失」一种情形**：
 *   - Origin **存在**：调用方仍按原语义要求它与 Host 同源（不放宽）；
 *   - Origin 缺失：只信任**回环对端**（本机进程/宿主转发），非回环一律拒绝。
 *
 * CSRF 面没有扩大：浏览器发起的跨站请求（表单/脚本/fetch）**必然携带
 * Origin**；插件写接口又强制 `Content-Type: application/json`，跨站请求会
 * 先触发预检（OPTIONS），而本插件从不回应预检——请求根本到不了无 Origin
 * 分支。能走到该分支的只有本机进程：桌面宿主转发、curl 等本地工具。
 *
 * 零依赖（无 import）：lib/api.js 与 lib/advisor/api.js 共用本判定，避免两处
 * 本地副本的放行条件漂移。
 *
 * @module dsh-memory-evolve/origin-guard
 */

/** IPv4 回环地址（127.0.0.0/8）。 */
const IPV4_LOOPBACK_RE = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
/** IPv4-mapped IPv6 回环（::ffff:127.x.x.x，Node 双栈监听时的对端形状）。 */
const IPV4_MAPPED_LOOPBACK_RE = /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i

/**
 * 单个地址是否为回环地址（含 IPv6 回环 `::1` 与 IPv4-mapped 形式）。
 * @param {unknown} address - socket 对端地址（req.socket.remoteAddress）。
 * @returns {boolean} true = 回环地址。
 */
export function isLoopbackAddress(address) {
  const addr = String(address ?? '').trim().toLowerCase()
  if (addr === '') return false
  if (addr === '::1') return true
  return IPV4_LOOPBACK_RE.test(addr) || IPV4_MAPPED_LOOPBACK_RE.test(addr)
}

/**
 * `Host` 头是否为回环主机：`127.0.0.1[:port]` / `localhost[:port]` /
 * `[::1][:port]`。仅在拿不到 socket 信息时用于兜底判定。
 * @param {unknown} host - req.headers.host。
 * @returns {boolean} true = 回环主机。
 */
export function isLoopbackHost(host) {
  const raw = String(host ?? '').trim().toLowerCase()
  if (raw === '') return false
  let bare = raw
  if (raw.startsWith('[')) {
    // IPv6 字面量：[::1] 或 [::1]:port
    const end = raw.indexOf(']')
    bare = end === -1 ? raw.slice(1) : raw.slice(1, end)
  } else {
    bare = raw.replace(/:\d+$/, '') // 去掉 IPv4/hostname 的端口
  }
  return bare === 'localhost' || bare === '::1' || bare === '127.0.0.1' || IPV4_LOOPBACK_RE.test(bare)
}

/**
 * 无 Origin 头的请求是否可放行（桌面宿主转发/本地工具）。
 *
 * 判定顺序（对应 PR #91 契约）：
 *   1. 优先 socket 对端地址（`req.socket.remoteAddress`，兜底
 *      `req.connection.remoteAddress`）——必须是回环；
 *   2. 无 socket 信息时看 `Host` 头——必须是回环主机；
 *   3. 连 `Host` 头都没有（进程内合成的请求对象）：放行；
 *   4. 其余（非回环对端 / 非回环 Host）一律拒绝。
 *
 * @param {object} req - node http 请求对象（或同形状的合成对象）。
 * @returns {boolean} true = 无 Origin 也允许通过同源保护。
 */
export function allowAbsentOrigin(req) {
  if (!req || typeof req !== 'object') return false
  const socket = req.socket ?? req.connection
  const remote = socket?.remoteAddress
  if (remote !== undefined && remote !== null && String(remote) !== '') {
    return isLoopbackAddress(remote)
  }
  const host = req.headers?.host
  if (host === undefined || host === null || String(host) === '') return true
  return isLoopbackHost(host)
}
