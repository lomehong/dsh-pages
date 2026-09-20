#!/usr/bin/env node
/**
 * ci-check — 语法/清单/结构校验（CI 与本地同一实现，零依赖）。
 *
 * 覆盖：
 * - 全仓 .js/.mjs/.cjs 语法检查（ESM 文件经临时 .mjs 交 node --check 确定性解析；
 *   CJS 经临时 .cjs；模块类型按最近 package.json 的 type 判定）；
 * - 所有 package.json 可解析且含 name；
 * - cordis.patch.yml 非空且不含 TAB。
 *
 * 排除目录：node_modules / data / vendor / dist / .git。
 * 退出码：0 = 全部通过；1 = 存在 error（fail-closed）。
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

const SKIP_DIRS = new Set(['node_modules', 'data', 'vendor', 'dist', '.git'])
const errors = []
const checked = { js: 0, manifest: 0 }

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.endsWith('.bak-widget')) continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** 最近 package.json 的 type 字段（'module' | 'commonjs' | undefined）。 */
function isModule(file) {
  let dir = dirname(file)
  while (true) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg.type) return pkg.type
    } catch { /* 无 package.json，继续向上 */ }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

const root = process.cwd()
const files = walk(root)
const tmp = mkdtempSync(join(tmpdir(), 'ci-check-'))
try {
  let pending = 0
  for (const file of files) {
    const rel = relative(root, file) || file
    if (/\.(js|mjs|cjs)$/.test(file)) {
      checked.js++
      let src
      try { src = readFileSync(file, 'utf8') } catch (e) { errors.push(`${rel}: 不可读（${e.message}）`); continue }
      const esm = isModule(file) || file.endsWith('.mjs')
      const ext = esm ? '.mjs' : '.cjs'
      const tmpFile = join(tmp, `check-${checked.js}${ext}`)
      writeFileSync(tmpFile, src)
      const r = spawnSync(process.execPath, ['--check', tmpFile], { encoding: 'utf8' })
      if (r.status !== 0) errors.push(`${rel}: 语法错误\n${(r.stderr || '').trim()}`)
      pending++
    } else if (file.endsWith('package.json')) {
      checked.manifest++
      let j
      try { j = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { errors.push(`${rel}: package.json 非法 JSON（${e.message}）`); continue }
      if (!j.name) errors.push(`${rel}: package.json 缺 name`)
    } else if (file.endsWith('cordis.patch.yml')) {
      checked.manifest++
      const c = readFileSync(file, 'utf8')
      if (c.trim() === '') errors.push(`${rel}: cordis.patch.yml 为空`)
      if (/\t/.test(c)) errors.push(`${rel}: cordis.patch.yml 含 TAB（YAML 禁止）`)
    }
  }
  rmSync(tmp, { recursive: true, force: true })
  console.log(`ci-check：JS ${checked.js} ｜ 清单 ${checked.manifest} ｜ 错误 ${errors.length}`)
  for (const e of errors) console.error('  ⛔ ' + e)
  process.exit(errors.length > 0 ? 1 : 0)
} catch (e) {
  console.error('⛔ ci-check 内部错误（fail-closed）：' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
}
