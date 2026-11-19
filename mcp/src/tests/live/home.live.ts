/**
 * The live server must leave the person's own setup alone. At start-up the server tells a
 * standing session where its CLI is (`recordCliPath` writes `~/.quarterdeck/runner/cli-path`),
 * and the standing session's next check would then start the test build's CLI on the person's
 * database (seen 19 Nov 2026: it migrated it). recordCliPath does nothing when the server's database
 * isn't the home's own, as here (QUARTERDECK_DB is set). server.ts also gives the server a home folder
 * of its own under the temp folder, with a standing session's launch.mjs in it, so recordCliPath would
 * have somewhere to write: this proves it wrote neither there nor in the real home.
 *
 * Run with `npm run test:live --prefix mcp` (it builds the bundle first).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startLiveServer, type LiveServer } from './server.js'

/** The real home's cli-path, read before the server starts (CI has none). */
const realCliPath = join(homedir(), '.quarterdeck', 'runner', 'cli-path')
const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : null)
const before = read(realCliPath)

let server: LiveServer
beforeAll(async () => { server = await startLiveServer() })
afterAll(async () => { await server?.stop() })

describe("the person's setup", () => {
  it('never repoints a standing session at a test build: a server on a test database records no CLI', async () => {
    await server.call('goals_overview', {})
    expect(server.home).not.toBe(homedir())
    expect(read(join(server.home, '.quarterdeck', 'runner', 'cli-path'))).toBeNull()
    expect(read(realCliPath)).toBe(before)
  })
})
