/**
 * Starts the bundled MCP server (the file the quarterdeck-goals plugin ships) and talks to it
 * over stdio, as Claude Code does. The live tests run against it, so they cover what the
 * handler tests can't: the bundle, the wire, a database file with real migrations, and watch
 * commands that really run.
 *
 * Everything is in a folder of its own under the system's temp folder: the database, the goals'
 * working directories, and the server's home folder. The home folder matters: at start-up the
 * server tells the standing session where its CLI is (`recordCliPath`, in `~/.quarterdeck/runner`),
 * and a test must never repoint a real standing session at a test build.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from '@quarterdeck/core'

const here = dirname(fileURLToPath(import.meta.url))
export const BUNDLE = resolve(here, '..', '..', '..', '..', 'plugins', 'quarterdeck-goals', 'server', 'quarterdeck-mcp.mjs')

/** A watch command that prints lines.txt: `node` is there on every platform, `cat` is not. */
export const PRINT_LINES = 'node print.cjs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Answer = any

export interface LiveServer {
  /** Calls a tool and gives its answer; throws when the server refuses the call. */
  call(tool: string, args?: Record<string, unknown>): Promise<Answer>
  /** Calls a tool the server should refuse and gives the refusal's text; throws when it goes through. */
  refused(tool: string, args?: Record<string, unknown>): Promise<string>
  /** The server's database, for what no tool reports (a run's self_caused) and for moving a watch's clock. */
  db: Database
  /** A new working directory for a goal, with lines.txt and the script PRINT_LINES runs. */
  workDir(name: string): string
  stop(): Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function startLiveServer(): Promise<LiveServer> {
  if (!existsSync(BUNDLE)) throw new Error(`No server bundle at ${BUNDLE}. Build it first: npm run bundle --prefix mcp`)
  const root = mkdtempSync(join(tmpdir(), 'quarterdeck-live-'))
  const home = join(root, 'home')
  const dbPath = join(root, 'tasks.db')
  mkdirSync(home)

  const child: ChildProcess = spawn(process.execPath, [BUNDLE], {
    env: { ...process.env, USERPROFILE: home, HOME: home, QUARTERDECK_DB: dbPath, QUARTERDECK_UPDATE_CHECK: '0', QUARTERDECK_SKIP_HOOKS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr!.on('data', (d) => { stderr = (stderr + d).slice(-4000) })
  let exited: string | null = null
  const gone = new Promise<void>((done) => child.on('exit', (code) => { exited = `The server exited (code ${code}). Its last output:\n${stderr}`; fail(exited); done() }))

  // One JSON message per line, each answer matched to its request by id
  const waiting = new Map<number, { resolve: (m: Answer) => void; reject: (e: Error) => void }>()
  function fail(why: string) {
    for (const w of waiting.values()) w.reject(new Error(why))
    waiting.clear()
  }
  let buffer = ''
  child.stdout!.on('data', (d) => {
    buffer += d
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i).trim()
      buffer = buffer.slice(i + 1)
      if (!line) continue
      const msg = JSON.parse(line) as { id?: number }
      if (msg.id !== undefined) { waiting.get(msg.id)?.resolve(msg); waiting.delete(msg.id) }
    }
  })
  let nextId = 1
  const rpc = (method: string, params: unknown) => new Promise<Answer>((res, rej) => {
    if (exited) return rej(new Error(exited))
    const id = nextId++
    waiting.set(id, { resolve: res, reject: rej })
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'quarterdeck-live-test', version: '0' } })
  child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

  /** The tool's answer as text, and whether the server marked it an error. */
  async function raw(tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const r = await rpc('tools/call', { name: tool, arguments: args })
    // Runs and decisions are ordered by their timestamps (milliseconds): keep two calls from sharing one
    await sleep(15)
    if (r.error) return { text: JSON.stringify(r.error), isError: true }
    return { text: r.result?.content?.[0]?.text ?? '', isError: Boolean(r.result?.isError) }
  }

  // The server made the database (and ran its migrations) when it started
  const db = new Database(dbPath)

  return {
    db,
    async call(tool, args = {}) {
      const r = await raw(tool, args)
      if (r.isError) throw new Error(`${tool} was refused: ${r.text}`)
      try { return JSON.parse(r.text) } catch { return r.text }
    },
    async refused(tool, args = {}) {
      const r = await raw(tool, args)
      if (!r.isError) throw new Error(`${tool} should have been refused, but answered: ${r.text.slice(0, 300)}`)
      return r.text
    },
    workDir(name) {
      const dir = join(root, name)
      mkdirSync(dir)
      writeFileSync(join(dir, 'lines.txt'), 'first\n')
      writeFileSync(join(dir, 'print.cjs'), "process.stdout.write(require('fs').readFileSync('lines.txt', 'utf8'))\n")
      return dir
    },
    async stop() {
      db.close()
      child.stdin!.end()
      child.kill()
      await Promise.race([gone, sleep(5000)])
      // Windows lets go of the database file a moment after the process ends
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    },
  }
}
