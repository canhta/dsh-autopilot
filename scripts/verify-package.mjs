import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const packagePath = process.argv[2]
if (!packagePath) throw new Error('usage: verify-package.mjs <package.tgz>')

const root = process.cwd()
const artifact = isAbsolute(packagePath) ? packagePath : resolve(root, packagePath)
const dshHome = mkdtempSync(join(tmpdir(), 'dsh-autopilot-package-'))
const profile = join(dshHome, 'profiles', 'autopilot-package-smoke')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: dshHome },
  })
  if (result.status !== 0) {
    throw new Error([`${command} ${args.join(' ')} failed`, result.stdout, result.stderr].filter(Boolean).join('\n'))
  }
  return result.stdout
}

try {
  run(npx, [
    '--yes',
    '@deepseek-ai/dsh@latest',
    '--profile',
    'autopilot-package-smoke',
    '--from-default-profile',
    'web',
    '--dump-config',
  ])
  run(npx, ['--yes', '@deepseek-ai/dsh@latest', 'plugin', '--profile', 'autopilot-package-smoke', 'add', artifact])
  run(pnpm, ['--dir', profile, 'peers', 'check'])
  const config = run(npx, ['--yes', '@deepseek-ai/dsh@latest', '--profile', 'autopilot-package-smoke', '--dump-config'])
  if (!config.includes('# == dsh-autopilot\n') || !config.includes('- id: autopilot\n  name: dsh-autopilot\n')) {
    throw new Error('installed profile does not contain the dsh-autopilot bundle layer')
  }
} finally {
  rmSync(dshHome, { recursive: true, force: true })
}
