import { describe, expect, it } from 'vitest'
import { parseSettingsDraft, toSettingsDraft } from '../src/client/settings-draft.js'
import type { AutopilotSettings } from '../src/config.js'

const settings: AutopilotSettings = {
  trackerProvider: 'jira',
  codeHostProvider: 'github',
  allowWorkflowChanges: true,
  notificationSubscriptions: [
    {
      providerId: 'ntfy',
      destinationId: 'operators',
      events: ['blocked', 'failed'],
      summaryDisclosure: 'redacted',
    },
  ],
  runUrlTemplate: 'https://host/runs/{runId}',
  issueUrlTemplate: 'https://jira/issues/{displayKey}',
  maxQueued: 20,
  maxRunning: 2,
  maxBriefBytes: 32_768,
  reconcileIntervalSeconds: 300,
  executionMode: 'disabled',
  targetRepository: '',
  targetBaseBranch: '',
  managedWorktreeRoot: '',
  runtimeStorePath: '/var/lib/autopilot/state.sqlite',
  autoCleanupEnabled: true,
  cleanupRetentionDays: 7,
  deploymentTokenCap: 100_000,
  perRunTokenCap: 50_000,
  runTokenAllowance: 40_000,
}

describe('Autopilot Settings draft', () => {
  it('round-trips browser-editable settings without exposing the Host storage assertion', () => {
    const draft = toSettingsDraft(settings)
    draft.notificationSubscriptions[0]?.events.push('completed')

    expect(draft).not.toHaveProperty('runtimeStorePath')
    expect(settings.notificationSubscriptions[0]?.events).toEqual(['blocked', 'failed'])
    expect(parseSettingsDraft(draft, settings)).toEqual({
      ...settings,
      notificationSubscriptions: [
        { ...settings.notificationSubscriptions[0], events: ['blocked', 'failed', 'completed'] },
      ],
    })
  })

  it('rejects an incomplete or duplicate notification destination before Host mutation', () => {
    const draft = toSettingsDraft(settings)
    const subscription = draft.notificationSubscriptions[0]
    if (subscription === undefined) throw new Error('expected notification fixture')
    draft.notificationSubscriptions = [subscription, { ...subscription }]

    expect(parseSettingsDraft(draft, settings)).toBeUndefined()
  })
})
