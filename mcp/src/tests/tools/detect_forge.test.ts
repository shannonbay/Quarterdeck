import { describe, it, expect, vi } from 'vitest'
import { detect_forge, remoteHost } from '../../tools/detect_forge.js'
import type { RunFile } from '@quarterdeck/core'

const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })

/** A fake runner: origin's url, and the CLIs signed in to which hosts (absent CLI: not installed). */
function fake(url: string | null, signedIn: Record<string, string[] | undefined>): RunFile {
  return vi.fn(async (file: string, args: string[]) => {
    if (file === 'git') {
      if (url === null) throw new Error("error: No such remote 'origin'")
      return `${url}\n`
    }
    const hosts = signedIn[file]
    if (!hosts) throw enoent()
    if (args[0] === 'auth' && hosts.includes(args[3])) return ''
    throw new Error('not logged in')
  })
}

describe('remoteHost', () => {
  it('reads https, ssh and scp-like remotes', () => {
    expect(remoteHost('https://github.com/octo/app.git')).toBe('github.com')
    expect(remoteHost('https://user@GitLab.com/group/sub/app')).toBe('gitlab.com')
    expect(remoteHost('ssh://git@git.example.com:2222/group/app.git')).toBe('git.example.com')
    expect(remoteHost('git@github.com:octo/app.git')).toBe('github.com')
  })
  it('has no host for a local path', () => {
    expect(remoteHost('C:\\repos\\app')).toBeNull()
    expect(remoteHost('/srv/git/app.git')).toBeNull()
    expect(remoteHost('file:///srv/git/app.git')).toBeNull()
  })
})

describe('detect_forge', () => {
  it('knows github.com and says gh is signed in', async () => {
    const run = fake('git@github.com:octo/app.git', { gh: ['github.com'] })
    expect(await detect_forge({ working_dir: '/r' }, run)).toEqual({ forge: 'github', host: 'github.com', cli: 'gh', cli_installed: true, signed_in: true })
    expect(run).toHaveBeenCalledWith('git', ['-C', '/r', 'remote', 'get-url', 'origin'])
  })

  it('knows gitlab.com even when glab is missing', async () => {
    const run = fake('https://gitlab.com/group/app.git', { gh: ['github.com'] })
    expect(await detect_forge({ working_dir: '/r' }, run)).toEqual({ forge: 'gitlab', host: 'gitlab.com', cli: 'glab', cli_installed: false, signed_in: false })
  })

  it('says when the CLI is installed but not signed in', async () => {
    const run = fake('https://github.com/octo/app', { gh: [] })
    expect(await detect_forge({ working_dir: '/r' }, run)).toMatchObject({ forge: 'github', cli_installed: true, signed_in: false })
  })

  it('asks the CLIs about a self-hosted host', async () => {
    expect(await detect_forge({ working_dir: '/r' }, fake('git@git.corp.example:team/app.git', { gh: ['github.com'], glab: ['git.corp.example'] })))
      .toEqual({ forge: 'gitlab', host: 'git.corp.example', cli: 'glab', cli_installed: true, signed_in: true })
    expect(await detect_forge({ working_dir: '/r' }, fake('https://ghe.corp.example/team/app', { gh: ['ghe.corp.example'] })))
      .toMatchObject({ forge: 'github', host: 'ghe.corp.example' })
  })

  it("answers null for a host no CLI knows, and with no remote", async () => {
    expect(await detect_forge({ working_dir: '/r' }, fake('https://codeberg.org/me/app', { gh: [], glab: [] })))
      .toEqual({ forge: null, host: 'codeberg.org', cli: null, cli_installed: false, signed_in: false })
    expect(await detect_forge({ working_dir: '/r' }, fake(null, {})))
      .toEqual({ forge: null, host: null, cli: null, cli_installed: false, signed_in: false })
  })

  it('needs a working_dir', async () => {
    await expect(detect_forge({}, fake(null, {}))).rejects.toThrow()
  })
})
