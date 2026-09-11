import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = process.cwd()
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const artifactName = `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`
const artifact = resolve(root, '.artifacts', artifactName)
const dshHome = mkdtempSync(join(tmpdir(), 'dsh-autopilot-package-'))
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const dsh = ['--yes', '@deepseek-ai/dsh@latest']

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

function redact(output) {
  return output.replaceAll(/token=[^\s]+/g, 'token=[redacted]')
}

function bootProfile(profileName) {
  return new Promise((resolveBoot, rejectBoot) => {
    const child = spawn(npx, [...dsh, '--profile', profileName, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd: root,
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let ready = false
    let timedOut = false
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, 15_000)

    child.stdout.on('data', (chunk) => {
      const output = String(chunk)
      stdout = `${stdout}${output}`.slice(-8_000)
      if (output.includes('dsh web: http://127.0.0.1:')) {
        ready = true
        child.kill('SIGTERM')
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8_000)
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      rejectBoot(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      const output = redact(`${stdout}\n${stderr}`)
      if (timedOut) rejectBoot(new Error(`${profileName} did not reach Web readiness within 15 seconds\n${output}`))
      else if (ready) resolveBoot()
      else rejectBoot(new Error(`${profileName} exited before Web readiness (code ${String(code)})\n${output}`))
    })
  })
}

function assertMissingEntryFails(profileDirectory) {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', "await import('dsh-autopilot-missing-entry')"],
    {
      cwd: profileDirectory,
      encoding: 'utf8',
      timeout: 15_000,
    },
  )
  if (result.error) throw result.error
  const diagnostic = `${result.stdout}\n${result.stderr}`
  if (result.status === 0) throw new Error('missing-entry package unexpectedly resolved')
  if (!diagnostic.includes('ERR_MODULE_NOT_FOUND') || !diagnostic.includes('missing.js')) {
    throw new Error(`missing-entry package failed for an unrelated reason\n${diagnostic}`)
  }
}

try {
  const dshVersion = run(npx, [...dsh, '--version']).trim()
  run(npx, [...dsh, '--profile', 'autopilot-package-smoke', '--from-default-profile', 'web', '--dump-config'])
  run(npx, [...dsh, 'plugin', '--profile', 'autopilot-package-smoke', 'add', artifact])
  const config = run(npx, [...dsh, '--profile', 'autopilot-package-smoke', '--dump-config'])
  if (!config.includes('# == dsh-autopilot\n') || !config.includes('- id: autopilot\n  name: dsh-autopilot\n')) {
    throw new Error('installed profile does not contain the dsh-autopilot bundle layer')
  }
  await bootProfile('autopilot-package-smoke')

  const brokenPackage = join(dshHome, 'missing-entry')
  mkdirSync(brokenPackage)
  writeFileSync(
    join(brokenPackage, 'package.json'),
    JSON.stringify({
      name: 'dsh-autopilot-missing-entry',
      version: '0.0.0',
      type: 'module',
      main: './missing.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
  )
  writeFileSync(
    join(brokenPackage, 'cordis.patch.yml'),
    '- insert:\n    - id: missing-entry\n      name: dsh-autopilot-missing-entry\n',
  )
  run(npx, [...dsh, '--profile', 'missing-entry-smoke', '--from-default-profile', 'web', '--dump-config'])
  run(npx, [...dsh, 'plugin', '--profile', 'missing-entry-smoke', 'add', brokenPackage])
  assertMissingEntryFails(join(dshHome, 'profiles', 'missing-entry-smoke'))

  process.stdout.write(`Verified ${artifactName} with DSH ${dshVersion}.\n`)
} finally {
  rmSync(dshHome, { recursive: true, force: true })
}
