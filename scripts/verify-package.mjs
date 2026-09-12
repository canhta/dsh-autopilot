import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = process.cwd()
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const artifactName = `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`
const artifact = resolve(root, '.artifacts', artifactName)
const dshHome = mkdtempSync(join(tmpdir(), 'dsh-autopilot-package-'))
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const dsh = ['--yes', '@deepseek-ai/dsh@0.1.5-rc.1']

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

function signalProcessTree(child, processGroupId, signal) {
  try {
    if (process.platform === 'win32') {
      if (child.exitCode === null) child.kill(signal)
    } else if (processGroupId !== undefined) process.kill(-processGroupId, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

function bootProfile(profileName) {
  return new Promise((resolveBoot, rejectBoot) => {
    const child = spawn(npx, [...dsh, '--profile', profileName, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd: root,
      detached: process.platform !== 'win32',
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const processGroupId = child.pid
    let ready = false
    let timedOut = false
    let stdout = ''
    let stderr = ''
    let forceKillTimeout
    const stopProcessTree = () => {
      signalProcessTree(child, processGroupId, 'SIGTERM')
      forceKillTimeout ??= setTimeout(() => signalProcessTree(child, processGroupId, 'SIGKILL'), 3_000)
    }
    const timeout = setTimeout(() => {
      timedOut = true
      stopProcessTree()
    }, 15_000)

    child.stdout.on('data', (chunk) => {
      const output = String(chunk)
      stdout = `${stdout}${output}`.slice(-8_000)
      if (output.includes('dsh web: http://127.0.0.1:')) {
        ready = true
        stopProcessTree()
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8_000)
    })
    child.once('error', (error) => {
      clearTimeout(timeout)
      clearTimeout(forceKillTimeout)
      rejectBoot(error)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      clearTimeout(forceKillTimeout)
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

function assertPackageSubpaths(profileDirectory) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      [
        "import { readFile } from 'node:fs/promises'",
        "import { fileURLToPath } from 'node:url'",
        "const github = await import('@canhta/dsh-autopilot/github-issues')",
        "const web = await import('@canhta/dsh-autopilot/web')",
        "const typert = await import('@canhta/dsh-autopilot/typert')",
        "const remote = await import('@canhta/dsh-autopilot/remote')",
        "const client = await readFile(fileURLToPath(import.meta.resolve('@canhta/dsh-autopilot/client')), 'utf8')",
        "const methods = typert.TYPERT.invocations.map((item) => item.method).sort().join(',')",
        "if (github.name !== 'dsh-autopilot-github-issues' || typeof github.registerGitHubIssuesProvider !== 'function' || typeof web.AutopilotWeb !== 'function' || methods !== 'command,commandStatus,operations,previewCleanup,run,testProvider,worktree' || remote.TYPERT_REMOTE.descriptors.length !== 7 || !client.startsWith('window.__ModuleLoader__.load({\\n\\tid: \"@canhta/dsh-autopilot\"') || !client.includes('autopilot-operations')) process.exitCode = 1",
      ].join(';'),
    ],
    { cwd: profileDirectory, encoding: 'utf8', timeout: 15_000 },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      ['package subpaths did not expose the Host, Client and Typert loader contracts', result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n'),
    )
  }
}

function assertGitHubCodeHostSubpath(profileDirectory) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "const entry = await import('@canhta/dsh-autopilot/github-code-host'); if (entry.name !== 'dsh-autopilot-github-code-host' || typeof entry.registerGitHubCodeHostProvider !== 'function') process.exitCode = 1",
    ],
    { cwd: profileDirectory, encoding: 'utf8', timeout: 15_000 },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      ['GitHub code-host package subpath did not expose its loader contract', result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n'),
    )
  }
}

function assertGitHubIssuesSubpath(profileDirectory) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "const entry = await import('@canhta/dsh-autopilot/github-issues'); if (entry.name !== 'dsh-autopilot-github-issues' || typeof entry.registerGitHubIssuesProvider !== 'function') process.exitCode = 1",
    ],
    { cwd: profileDirectory, encoding: 'utf8', timeout: 15_000 },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      ['GitHub Issues package subpath did not expose its loader contract', result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n'),
    )
  }
}

function assertIntegrationSubpaths(profileDirectory) {
  const checks = {
    '@canhta/dsh-autopilot/code-host': ['CodeHost'],
    '@canhta/dsh-autopilot/delivery': ['Delivery'],
    '@canhta/dsh-autopilot/notification': ['Notifications'],
    '@canhta/dsh-autopilot/publication': ['Publication'],
    '@canhta/dsh-autopilot/workflow': ['Workflow'],
    '@canhta/dsh-autopilot/webhook-notification': ['apply', 'name'],
    '@canhta/dsh-autopilot/ntfy-notification': ['apply', 'name'],
  }
  const program = `const checks = ${JSON.stringify(checks)}; for (const [entry, names] of Object.entries(checks)) { const loaded = await import(entry); for (const name of names) if (!(name in loaded)) throw new Error(entry + ' omitted ' + name) }`
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    cwd: profileDirectory,
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      [
        'Packed publication/delivery/notification entries did not expose their public contracts',
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
}

function assertOperationsSubpath(profileDirectory) {
  const packageDirectory = join(profileDirectory, 'node_modules', '@canhta', 'dsh-autopilot')
  const installedManifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'))
  const operationsExport = installedManifest.exports?.['./operations']
  if (
    operationsExport?.types !== './lib/operations.d.ts' ||
    operationsExport?.default !== './lib/operations.js' ||
    !existsSync(join(packageDirectory, operationsExport.types)) ||
    !existsSync(join(packageDirectory, operationsExport.default))
  ) {
    throw new Error('Operations package subpath is missing its installed export contract')
  }
  if (
    installedManifest.exports?.['./testing'] !== undefined ||
    existsSync(join(packageDirectory, 'lib', 'testing.js'))
  ) {
    throw new Error('source-only test fixtures leaked into the public package')
  }
  for (const required of [
    'AGENTS.md',
    'CONTEXT.md',
    'README.md',
    'docs/CONTRIBUTING.md',
    'docs/README.md',
    'docs/assets/banner.png',
    'docs/deployment.md',
  ]) {
    if (!existsSync(join(packageDirectory, required))) {
      throw new Error(`packed documentation is missing ${required}`)
    }
  }
  if (existsSync(join(packageDirectory, 'docs', 'research'))) {
    throw new Error('local docs/research must not be published in the package')
  }
  const readme = readFileSync(join(packageDirectory, 'README.md'), 'utf8')
  if (
    !readme.includes('## What problem it solves') ||
    !readme.includes("<summary>Don't have DSH installed?</summary>") ||
    !readme.includes('dsh plugin --profile web add @canhta/dsh-autopilot@alpha') ||
    readme.includes('releases/download/')
  ) {
    throw new Error('packed README is stale or missing the user installation path')
  }
}

try {
  const dshVersion = run(npx, [...dsh, '--version']).trim()
  run(npx, [...dsh, '--profile', 'autopilot-package-smoke', '--from-default-profile', 'web', '--dump-config'])
  run(npx, [...dsh, 'plugin', '--profile', 'autopilot-package-smoke', 'add', artifact])
  const config = run(npx, [...dsh, '--profile', 'autopilot-package-smoke', '--dump-config'])
  if (
    !config.includes('# == @canhta/dsh-autopilot\n') ||
    !config.includes("- id: autopilot\n  name: '@canhta/dsh-autopilot'\n") ||
    !config.includes("- id: autopilot-jira\n  name: '@canhta/dsh-autopilot/jira'\n") ||
    !config.includes("- id: autopilot-github-issues\n  name: '@canhta/dsh-autopilot/github-issues'\n") ||
    !config.includes("- id: autopilot-github-code-host\n  name: '@canhta/dsh-autopilot/github-code-host'\n") ||
    !config.includes("- id: autopilot-webhook-notification\n  name: '@canhta/dsh-autopilot/webhook-notification'\n") ||
    !config.includes("- id: autopilot-ntfy-notification\n  name: '@canhta/dsh-autopilot/ntfy-notification'\n")
  ) {
    throw new Error('installed profile does not contain the dsh-autopilot bundle layer')
  }
  assertPackageSubpaths(join(dshHome, 'profiles', 'autopilot-package-smoke'))
  assertGitHubIssuesSubpath(join(dshHome, 'profiles', 'autopilot-package-smoke'))
  assertGitHubCodeHostSubpath(join(dshHome, 'profiles', 'autopilot-package-smoke'))
  assertIntegrationSubpaths(join(dshHome, 'profiles', 'autopilot-package-smoke'))
  assertOperationsSubpath(join(dshHome, 'profiles', 'autopilot-package-smoke'))
  await bootProfile('autopilot-package-smoke')
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
