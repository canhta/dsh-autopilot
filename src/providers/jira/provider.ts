import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import {
  TRACKER_INTERFACE_VERSION,
  type TrackerIssueSnapshot,
  type TrackerProvider,
  TrackerProviderError,
  trackerProviderId,
} from '../../tracker.js'
import { verifyJiraIngress } from './ingress.js'
import { normalizeIssue } from './normalization.js'
import { createJiraRequest, parseProviderResponse } from './request.js'
import { searchSchema } from './schemas.js'
import { type JiraSettings, jiraSettingsSchema, requireConfiguredSettings, validateStoredSettings } from './settings.js'

const jiraProviderId = trackerProviderId('jira')

export const name = 'dsh-autopilot-jira'
export const inject = ['tracker', 'settings', 'credentials']

/** Register the Jira settings and provider adapter on the calling plugin fiber. */
export function registerJiraProvider(ctx: Context, fetchImplementation: typeof fetch): () => Promise<void> {
  const settings = ctx.settings.register('dsh-autopilot-jira', jiraSettingsSchema, {
    validate: validateStoredSettings,
  })
  return ctx.tracker.register(createJiraProvider(ctx, settings, fetchImplementation))
}

export function apply(ctx: Context): void {
  ctx.effect(() => registerJiraProvider(ctx, globalThis.fetch))
}

function createJiraProvider(
  ctx: Context,
  settings: SettingsScope<JiraSettings>,
  fetchImplementation: typeof fetch,
): TrackerProvider {
  return {
    id: jiraProviderId,
    interfaceVersion: TRACKER_INTERFACE_VERSION,
    displayName: 'Jira Cloud',
    configurationNamespace: 'dsh-autopilot-jira',
    capabilities: ['candidates', 'comments', 'dependencies', 'readiness', 'ingress'],
    async readCandidates({ cursor, signal }) {
      const config = requireConfiguredSettings(settings.get())
      const resolved = await ctx.credentials.resolve(credentialRef(config.credentialRef))
      if (resolved === undefined) {
        throw new TrackerProviderError('authentication', 'Jira credential reference is not configured')
      }
      const request = createJiraRequest(fetchImplementation, config, resolved.value, signal)
      const raw = await request('/rest/api/3/search/jql', {
        method: 'POST',
        body: JSON.stringify({
          jql: `project = "${escapeJql(config.projectKey)}" AND labels = "${escapeJql(config.readyLabel)}" ORDER BY created ASC, key ASC`,
          fields: ['summary', 'priority', 'labels', 'issuelinks'],
          maxResults: config.pageSize,
          ...(cursor === undefined ? {} : { nextPageToken: cursor }),
        }),
      })
      const page = parseProviderResponse(searchSchema, raw, 'Jira search response')
      const issues: TrackerIssueSnapshot[] = []
      for (const issue of page.issues) issues.push(await normalizeIssue(issue, config, request))
      return {
        issues,
        ...(page.nextPageToken === undefined ? {} : { nextCursor: page.nextPageToken }),
      }
    },
    verifyIngress: (request) => verifyJiraIngress(ctx, settings, request),
  }
}

function escapeJql(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}
