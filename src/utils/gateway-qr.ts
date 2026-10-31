/**
 * 服务器分享二维码解析。
 *
 * 生成端协议见 TunnelProviderSection.vue 的 shareUrl：`${apiBaseUrl}/#token=<urlencoded>`。
 * 解析策略刻意宽松：
 * - URL 部分必填（非 http(s) 一律拒收，避免把无关二维码/恶意协议填进网关表单）；
 * - `#token=` 前缀大小写不敏感（手工生成的码可能写成 #Token=），可缺省——裸地址二维码
 *   （只贴了 URL）也允许导入，仅填地址不填令牌；
 * - token 解码失败不整单拒绝，回退原文（手工生成的码可能没做 encodeURIComponent）。
 *
 * 但「前缀命中却解不出可用令牌」一律整单拒收（返回 null）：用户明确想带令牌，
 * 静默降级成无令牌导入只会让人以为令牌已经导入成功。
 *
 * 返回 null 表示不是可导入的分享码，调用方负责提示且不得改动表单。
 */
export interface GatewayShareInfo {
    apiBaseUrl: string
    token: string
}

const TOKEN_HASH_PREFIX = '#token='

/**
 * 令牌合法字符白名单——单一实现，手机侧 utils/tunnel-hash.ts 的 parseTunnelHash 同样消费。
 *
 * token 会进 Authorization 请求头，而 fetch 的 Headers 按 ByteString 校验：控制字符与
 * 非 Latin-1 字符（中文、C1 控制区等）都会让构造直接抛 TypeError——该网关的全站请求
 * 随之报「网络错误」。令牌本质是 base64/hex/随机串，可打印 ASCII（0x21-0x7e）足够，
 * 超出即判坏码：宁可报 scanInvalid，也不把毒性令牌写进网关配置。
 */
const SHARE_TOKEN_ALLOWED = /^[\x21-\x7e]*$/

/** 令牌能否安全放进 Authorization 头（网关扫码与手机 hash 引导共用此判定） */
export function isValidShareToken(token: string): boolean {
    return SHARE_TOKEN_ALLOWED.test(token)
}

export function parseGatewayShareQr(text: string): GatewayShareInfo | null {
    const raw = text.trim()
    if (!raw) return null
    let url: URL
    try {
        url = new URL(raw)
    } catch {
        return null
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    let token = ''
    // 前缀匹配大小写不敏感；值按原串切片，不做大小写改写
    if (url.hash.toLowerCase().startsWith(TOKEN_HASH_PREFIX)) {
        const encoded = url.hash.slice(TOKEN_HASH_PREFIX.length)
        try {
            token = decodeURIComponent(encoded)
        } catch {
            token = encoded
        }
        token = token.trim()
        // 前缀命中却是空值（#token= / #token=%20%20）：明确想带令牌却拿到坏码，
        // 不降级为「只填地址」——那会让用户以为令牌已随码导入
        if (!token) return null
        if (!isValidShareToken(token)) return null
    }
    // 只取 origin+pathname：分享协议未定义 query——盲目保留 search 会让消费端
    // api-client 的字符串拼接（getBaseUrl()+path）整体错位；userinfo（basic auth
    // 凭据）同样不进表单，避免静默产出带凭据的网关地址
    const apiBaseUrl = `${url.origin}${url.pathname}`.replace(/\/+$/, '')
    return { apiBaseUrl, token }
}
