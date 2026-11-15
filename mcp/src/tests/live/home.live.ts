/**
 * The live server must leave the person's own setup alone. At start-up the server tells a
 * standing session where its CLI is (`recordCliPath` writes `~/.quarterdeck/runner/cli-path`),
 * and the standing session's next check would then start the test build's CLI. server.ts gives
 * the server a home folder of its own under the temp folder, with a standing session's launch.mjs
 * in it so recordCliPath has somewhere to write: this proves the server wrote there, and only there.
 *
 * Run with `npm run test:live --prefix mcp` (it builds the bundle first).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { BUNDLE, startLiveServer, type LiveServer } from './server.js'

/** The real home's cli-path, read before the server starts (CI has none). */
const realCliPath = join(homedir(), '.quarterdeck', 'runner', 'cli-path')
const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : null)
const before = read(realCliPath)

let server: LiveServer
beforeAll(async () => { server = await startLiveServer() })
afterAll(async () => { await server?.stop() })

describe("the person's setup", () => {
  it('runs the server in a home folder of its own, so a standing session is never repointed at a test build', async () => {
    await server.call('goals_overview', {})
    expect(server.home).not.toBe(homedir())
    expect(read(join(server.home, '.quarterdeck', 'runner', 'cli-path'))).toBe(join(dirname(BUNDLE), 'quarterdeck-cli.mjs'))
    expect(read(realCliPath)).toBe(before)
  })
})
