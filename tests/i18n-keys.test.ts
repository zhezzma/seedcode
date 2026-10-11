import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zhMessages from '../src/i18n/zh.ts'
import enMessages from '../src/i18n/en.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const srcDir = path.join(repoRoot, 'src')

/** 递归收集 src 下所有 .vue/.ts 文件（跳过 i18n 目录本身：那里是键定义不是键消费） */
function collectFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        const st = statSync(full)
        if (st.isDirectory()) {
            if (path.basename(full) === 'i18n') continue
            collectFiles(full, out)
        } else if (/\.(vue|ts)$/.test(entry)) {
            out.push(full)
        }
    }
    return out
}

/** 提取源码中所有字面量 i18n 键：模板 $t('…') 与脚本 t('…')（\bt 边界同时覆盖两者；
 *  动态键（模板字符串/拼接）无法静态解析，不在防护范围）。 */
function collectUsedKeys(): Set<string> {
    const keys = new Set<string>()
    for (const file of collectFiles(srcDir)) {
        const source = readFileSync(file, 'utf8')
        for (const m of source.matchAll(/\bt\('([^']+)'\)/g)) keys.add(m[1])
        for (const m of source.matchAll(/\bt\("([^"]+)"\)/g)) keys.add(m[1])
    }
    return keys
}

/** 按点分路径查消息对象；任一层缺失/非对象即 false */
function hasPath(messages: Record<string, unknown>, key: string): boolean {
    let node: unknown = messages
    for (const part of key.split('.')) {
        if (typeof node !== 'object' || node === null || !(part in (node as Record<string, unknown>))) {
            return false
        }
        node = (node as Record<string, unknown>)[part]
    }
    return true
}

test('i18n: src 中所有字面量 $t()/t() 键在 zh 与 en 中均存在（通用缺键防护）', () => {
    const usedKeys = collectUsedKeys()
    assert.ok(usedKeys.size > 100, `key extraction is suspiciously small (${usedKeys.size}) — scanner likely broken`)
    const missingZh: string[] = []
    const missingEn: string[] = []
    for (const key of usedKeys) {
        if (!hasPath(zhMessages, key)) missingZh.push(key)
        if (!hasPath(enMessages, key)) missingEn.push(key)
    }
    assert.deepEqual(missingZh, [], `keys missing in zh.ts:\n  ${missingZh.join('\n  ')}`)
    assert.deepEqual(missingEn, [], `keys missing in en.ts:\n  ${missingEn.join('\n  ')}`)
})
