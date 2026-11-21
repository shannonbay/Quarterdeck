/**
 * Packs the bundled MCP server into an MCPB bundle and writes server.json for
 * the official MCP Registry (io.github.shannonbay/quarterdeck). Called by
 * release.mjs after `npm run build --prefix mcp`.
 *
 * The bundle holds manifest.json (mcp/mcpb/manifest.json with the version set),
 * icon.png and server/quarterdeck-mcp.mjs + quarterdeck-cli.mjs (the server
 * records the CLI's path next to it, and doctor uses it).
 */
import { execSync } from 'child_process'
import { createHash } from 'crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export const REGISTRY_NAME = 'io.github.shannonbay/quarterdeck'
export const SERVER_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json'
const REPO_URL = 'https://github.com/shannonbay/Quarterdeck'

/** The release asset's download URL for a version. */
export const mcpbUrl = (version) => `${REPO_URL}/releases/download/v${version}/quarterdeck-${version}.mcpb`

/** Builds dist/quarterdeck-<version>.mcpb from the built server; returns its path and SHA-256. */
export function buildMcpb(root, version) {
  const serverDir = join(root, 'plugins', 'quarterdeck-goals', 'server')
  for (const f of ['quarterdeck-mcp.mjs', 'quarterdeck-cli.mjs']) {
    if (!existsSync(join(serverDir, f))) throw new Error(`${f} was not built (npm run build --prefix mcp)`)
  }
  const work = mkdtempSync(join(tmpdir(), 'quarterdeck-mcpb-'))
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'mcp', 'mcpb', 'manifest.json'), 'utf8'))
    manifest.version = version
    writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    cpSync(join(root, 'plugins', 'quarterdeck-goals', '.claude-plugin', 'icon.png'), join(work, 'icon.png'))
    mkdirSync(join(work, 'server'))
    for (const f of ['quarterdeck-mcp.mjs', 'quarterdeck-cli.mjs']) cpSync(join(serverDir, f), join(work, 'server', f))

    mkdirSync(join(root, 'dist'), { recursive: true })
    const file = join(root, 'dist', `quarterdeck-${version}.mcpb`)
    rmSync(file, { force: true })
    const mcpb = (args) => execSync(`npx mcpb ${args}`, { cwd: root, stdio: 'inherit' })
    mcpb(`validate "${join(work, 'manifest.json')}"`)
    mcpb(`pack "${work}" "${file}"`)
    if (!existsSync(file)) throw new Error(`mcpb pack did not write ${file}`)
    const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex')
    return { file, sha256 }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** The registry's server.json for a version and its bundle's SHA-256. */
export function serverJson(version, sha256) {
  return {
    $schema: SERVER_SCHEMA,
    name: REGISTRY_NAME,
    description: 'Persistent goals for Claude: standing objectives with items, memory and approvals.',
    repository: { url: REPO_URL, source: 'github' },
    version,
    packages: [
      {
        registryType: 'mcpb',
        identifier: mcpbUrl(version),
        version,
        fileSha256: sha256,
        transport: { type: 'stdio' },
      },
    ],
  }
}

/** Writes server.json at the repo root. */
export function writeServerJson(root, version, sha256) {
  writeFileSync(join(root, 'server.json'), JSON.stringify(serverJson(version, sha256), null, 2) + '\n')
}
