/**
 * Is a newer Quarterdeck published? The server compares the installed
 * plugin's version with the `release` branch's plugin.json (what people
 * install from) and says so in `goals_overview`, where the Goals pane offers
 * to ask Claude to install it.
 *
 * Claude Code may already have installed a newer version (plugin auto-update,
 * or an update made in another session) while this session still runs the old
 * one until /reload-plugins. Then the update is `ready`: the pane offers to
 * reload rather than to install. Claude Code's own record of what is installed,
 * `installed_plugins.json`, says which version is on disk.
 *
 * It never checks from a checkout (which updates with git, and whose tests
 * must not reach the network) or with `QUARTERDECK_UPDATE_CHECK=0`. The request
 * carries nothing about the person: it is a plain GET of a public file.
 */
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { envVar } from '@quarterdeck/core'

export const RELEASE_MANIFEST_URL = 'https://raw.githubusercontent.com/shannonbay/Quarterdeck/release/plugins/quarterdeck-goals/.claude-plugin/plugin.json'

/** How often to look once a check has answered, and how soon to try again after one that failed. */
export const CHECK_EVERY_MS = 6 * 60 * 60_000
export const RETRY_AFTER_MS = 30 * 60_000

/** `installed` is what this server runs; `ready`: `latest` is already installed and needs only /reload-plugins. */
export type AvailableUpdate = { installed: string; latest: string; ready?: true }

/** How Claude Code names the goals plugin in installed_plugins.json. */
export const PLUGIN_ID = 'quarterdeck-goals@quarterdeck'

const VERSION = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.]+)?$/

/** True when `latest` is a later version than `installed` (a pre-release comes before its release). */
export function isNewer(installed: string, latest: string): boolean {
  const a = VERSION.exec(installed)
  const b = VERSION.exec(latest)
  if (!a || !b) return false
  for (let i = 1; i <= 3; i++) {
    const d = Number(b[i]) - Number(a[i])
    if (d !== 0) return d > 0
  }
  return a[4] !== undefined && b[4] === undefined
}

export type UpdateDeps = {
  /** The installed plugin's version; null turns the check off. */
  installed: string | null
  /** The published version, or null when it can't be read. */
  fetchLatest: () => Promise<string | null>
  /** The newest version Claude Code has installed on disk, or null when unknown. */
  onDisk?: () => string | null
  now: () => number
}

export function createUpdateCheck(deps: UpdateDeps) {
  let latest: string | null = null
  let nextCheckAt = 0
  let pending: Promise<void> | null = null

  /** Looks now, unless a check is under way. Never rejects. */
  function check(): Promise<void> {
    pending ??= deps.fetchLatest()
      .catch(() => null)
      .then((v) => {
        if (v) latest = v
        nextCheckAt = deps.now() + (v ? CHECK_EVERY_MS : RETRY_AFTER_MS)
        pending = null
      })
    return pending
  }

  return {
    check,
    /** The update known so far; starts a check in the background when one is due, so it never waits on the network. */
    available(): AvailableUpdate | null {
      if (!deps.installed) return null
      // Installed but not loaded comes first: a reload is all it takes
      const disk = deps.onDisk?.() ?? null
      if (disk && isNewer(deps.installed, disk)) return { installed: deps.installed, latest: disk, ready: true }
      if (!pending && deps.now() >= nextCheckAt) void check()
      return latest && isNewer(deps.installed, latest) ? { installed: deps.installed, latest } : null
    },
  }
}

/**
 * The installed plugin's version, read from the plugin.json beside the bundled
 * server (<plugin>/server). Null in a checkout, when turned off, or when unknown.
 */
export function installedVersion(scriptDir: string = dirname(fileURLToPath(import.meta.url)), env: NodeJS.ProcessEnv = process.env): string | null {
  if (/^(0|false|off|no)$/i.test(envVar('UPDATE_CHECK', env) ?? '')) return null
  const plugin = join(scriptDir, '..')
  // A checkout has the sources beside the plugins folder: it updates with git, not from the release branch
  if (existsSync(join(plugin, '..', '..', 'mcp', 'src'))) return null
  try {
    const version = (JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: unknown }).version
    return typeof version === 'string' && VERSION.test(version) ? version : null
  } catch {
    return null
  }
}

/**
 * The newest version of the goals plugin in Claude Code's installed_plugins.json
 * (in CLAUDE_CONFIG_DIR, or ~/.claude), or null. Each scope it is installed in
 * has an entry; the newest counts.
 */
export function versionOnDisk(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
  try {
    const file = join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'plugins', 'installed_plugins.json')
    const entries = (JSON.parse(readFileSync(file, 'utf8')) as { plugins?: Record<string, { version?: unknown }[]> }).plugins?.[PLUGIN_ID]
    let newest: string | null = null
    for (const e of Array.isArray(entries) ? entries : []) {
      const v = typeof e?.version === 'string' && VERSION.test(e.version) ? e.version : null
      if (v && (!newest || isNewer(newest, v))) newest = v
    }
    return newest
  } catch {
    return null
  }
}

async function fetchReleaseVersion(): Promise<string | null> {
  const res = await fetch(RELEASE_MANIFEST_URL, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) return null
  const version = (await res.json() as { version?: unknown }).version
  return typeof version === 'string' && VERSION.test(version) ? version : null
}

let shared: ReturnType<typeof createUpdateCheck> | null = null

/** This server's update, if a newer Quarterdeck is published (see `createUpdateCheck`). */
export function availableUpdate(): AvailableUpdate | null {
  shared ??= createUpdateCheck({ installed: installedVersion(), fetchLatest: fetchReleaseVersion, onDisk: () => versionOnDisk(), now: Date.now })
  return shared.available()
}
