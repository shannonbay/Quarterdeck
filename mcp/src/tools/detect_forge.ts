/**
 * Which git host (forge) a folder's repo is on, for /goal-new's repo templates
 * (issue #44, step 2). The goals plugin has no shell, so it asks here.
 *
 * Reads only: `git remote get-url origin`, then the host's CLI's `auth status`.
 * Every command runs with an argument array (no shell), as status checks do.
 */
import { DetectForgeSchema } from '../schema.js'
import { defaultRunFile, type RunFile } from '@quarterdeck/core'

export type ForgeKind = 'github' | 'gitlab'

/** Each forge's CLI. */
export const FORGE_CLI: Record<ForgeKind, string> = { github: 'gh', gitlab: 'glab' }

/** The hosts known without asking a CLI. */
const KNOWN_HOSTS: Record<string, ForgeKind> = { 'github.com': 'github', 'gitlab.com': 'gitlab' }

export interface ForgeDetection {
  /** null: no remote, or a host neither CLI knows. */
  forge: ForgeKind | null
  /** The origin remote's host, or null when there is no origin remote. */
  host: string | null
  /** The forge's CLI (null when the forge isn't known). */
  cli: string | null
  cli_installed: boolean
  signed_in: boolean
}

/**
 * The host of a git remote URL: https://host/..., ssh://user@host:port/...,
 * or scp-like user@host:path. Lower case, without user or port; null when it
 * has none (a local path).
 */
export function remoteHost(url: string): string | null {
  const u = url.trim()
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+)/i.exec(u)
  if (scheme) return u.toLowerCase().startsWith('file:') ? null : scheme[1].toLowerCase()
  const scp = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/\/)/.exec(u)
  if (scp && !/^[a-z]$/i.test(scp[1])) return scp[1].toLowerCase() // not a Windows drive (C:\...)
  return null
}

/** True when the error says the program isn't there (ENOENT), not that it failed. */
function missing(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ENOENT'
}

/** Whether a CLI is installed and signed in to a host. */
async function authStatus(run: RunFile, cli: string, host: string): Promise<{ installed: boolean; signed_in: boolean }> {
  try {
    await run(cli, ['auth', 'status', '--hostname', host])
    return { installed: true, signed_in: true }
  } catch (err) {
    return { installed: !missing(err), signed_in: false }
  }
}

export async function detect_forge(args: unknown, run: RunFile = defaultRunFile): Promise<ForgeDetection> {
  const { working_dir } = DetectForgeSchema.parse(args)
  let url: string
  try {
    url = await run('git', ['-C', working_dir, 'remote', 'get-url', 'origin'])
  } catch {
    return { forge: null, host: null, cli: null, cli_installed: false, signed_in: false }
  }
  const host = remoteHost(url)
  if (!host) return { forge: null, host: null, cli: null, cli_installed: false, signed_in: false }

  const known = KNOWN_HOSTS[host]
  if (known) {
    const status = await authStatus(run, FORGE_CLI[known], host)
    return { forge: known, host, cli: FORGE_CLI[known], cli_installed: status.installed, signed_in: status.signed_in }
  }
  // Another host (GitHub Enterprise, self-managed GitLab): the CLI signed in to it says which
  for (const forge of ['github', 'gitlab'] as const) {
    const status = await authStatus(run, FORGE_CLI[forge], host)
    if (status.signed_in) return { forge, host, cli: FORGE_CLI[forge], cli_installed: true, signed_in: true }
  }
  return { forge: null, host, cli: null, cli_installed: false, signed_in: false }
}
