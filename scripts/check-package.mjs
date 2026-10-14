// Inspect npm's actual publish file list without creating or publishing an archive.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
assert(process.env.npm_execpath, 'Run this check with npm run check:package')
const result = spawnSync(process.execPath, [
  process.env.npm_execpath, 'pack', '--dry-run', '--json', '--ignore-scripts',
], { cwd: root, encoding: 'utf8', windowsHide: true })
if (result.error) throw result.error
assert.equal(result.status, 0, result.stderr || 'npm pack failed')
const [pack] = JSON.parse(result.stdout)
const files = new Set(pack.files.map(file => file.path))
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

async function sourceFiles(directory) {
  const entries = await readdir(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => {
    const name = `${directory}/${entry.name}`
    return entry.isDirectory() ? sourceFiles(name) : [name]
  }))
  return nested.flat()
}

const required = [
  manifest.main,
  ...manifest.pi.extensions.map(file => file.replace(/^\.\//, '')),
  'package.json', 'prompts/wechat.md', 'LICENSE', 'README.md', 'README.zh.md', 'CHANGELOG.md',
  'assets/logo.png', 'assets/cover.png',
  ...await sourceFiles('src'),
  ...await sourceFiles('docs'),
]
for (const file of required) assert(files.has(file), `Missing published file: ${file}`)
for (const file of files) {
  assert(!/^(?:tests|scripts|node_modules|\.github|\.pi-wechat-files)\//.test(file), `Unexpected published file: ${file}`)
  assert(!/(?:^|\/)\.env(?:\.|$)|\.(?:log|tgz)$/.test(file), `Unexpected local artifact: ${file}`)
}
console.log(`Package contents verified: ${files.size} files, including all runtime sources and the default prompt.`)
