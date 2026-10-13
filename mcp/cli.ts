#!/usr/bin/env node
/** JSON CLI over the same MCP protocol used by Codex and other clients. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { version } from '../package.json'

type ObjectInput = Record<string, unknown>
interface Operation { tool: string; args: ObjectInput }
const MAX_INPUT = 8 * 1024 * 1024
const HELP = `Doneline ${version} — control your existing workspace

  doneline status
  doneline today [--person ID]
  doneline day [YYYY-MM-DD] [--person ID]
  doneline week [YYYY-MM-DD] [--person ID]
  doneline search WORDS [--person ID] [--limit N]
  doneline sync
  doneline tools [TOOL]
  doneline call TOOL --input FILE
  doneline call TOOL --stdin
  doneline call TOOL --json '{"title":"Read 20 pages"}'
  doneline batch --input FILE
  doneline batch --stdin

Batch JSON: [{"tool":"add_todo","args":{"title":"Read 20 pages"}}]
Batches execute in order and stop on the first failure. Completed results are
returned so you can recover them; a batch is not an atomic database transaction.

All commands accept --data-dir PATH to use a different workspace, --server PATH
to use a different MCP bundle, and --timeout SECONDS (default 60, maximum 300).
Local date/time inputs use your computer's timezone. Output is JSON; failures
return a nonzero exit code. Credentials stay in Doneline's existing configuration.
`

function objectInput(value: unknown): ObjectInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool arguments must be a JSON object.')
  return value as ObjectInput
}

async function readInput(options: Map<string, string | boolean>): Promise<unknown> {
  const inputs = ['input', 'stdin', 'json'].filter(name => options.has(name))
  if (inputs.length > 1) throw new Error('Choose one of --input, --stdin, or --json.')
  if (!inputs.length) return {}
  let content: string
  if (options.has('input')) {
    const file = String(options.get('input'))
    if ((await fs.stat(file)).size > MAX_INPUT) throw new Error('Input exceeds the 8 MiB limit.')
    content = await fs.readFile(file, 'utf8')
  } else if (options.has('json')) content = String(options.get('json'))
  else {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_INPUT) throw new Error('Input exceeds the 8 MiB limit.')
      chunks.push(buffer)
    }
    content = Buffer.concat(chunks).toString('utf8')
  }
  if (Buffer.byteLength(content) > MAX_INPUT) throw new Error('Input exceeds the 8 MiB limit.')
  try { return JSON.parse(content.replace(/^\uFEFF/, '')) }
  catch { throw new Error('Input is not valid JSON. Use --input or --stdin to preserve quotes and Unicode.') }
}

function parse(argv: string[]): { command: string; positional: string[]; options: Map<string, string | boolean> } {
  const options = new Map<string, string | boolean>()
  const positional: string[] = []
  const values = new Set(['input', 'json', 'person', 'limit', 'data-dir', 'server', 'timeout'])
  for (let at = 0; at < argv.length; at++) {
    const token = argv[at]
    if (!token.startsWith('--')) { positional.push(token); continue }
    const equal = token.indexOf('=')
    const key = token.slice(2, equal < 0 ? undefined : equal)
    if (options.has(key)) throw new Error(`Duplicate option --${key}.`)
    if (values.has(key)) {
      const value = equal < 0 ? argv[++at] : token.slice(equal + 1)
      if (!value || value.startsWith('--')) throw new Error(`--${key} needs a value.`)
      options.set(key, value)
    } else if (['stdin', 'help', 'version'].includes(key) && equal < 0) options.set(key, true)
    else throw new Error(`Unknown option --${key}.`)
  }
  return { command: positional.shift() ?? 'help', positional, options }
}

async function main(): Promise<void> {
  const { command, positional, options } = parse(process.argv.slice(2))
  if (options.has('version') || command === 'version') { console.log(version); return }
  if (options.has('help') || command === 'help') { console.log(HELP); return }
  const commands = ['status', 'today', 'day', 'week', 'search', 'sync', 'tools', 'call', 'batch']
  if (!commands.includes(command)) throw new Error(`Unknown command ${command}. Run doneline help.`)
  const timeoutSeconds = Number(options.get('timeout') ?? 60)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) throw new Error('--timeout must be between 1 and 300 seconds.')
  const person = options.has('person') ? String(options.get('person')) : undefined
  let operations: Operation[] = []
  if (command === 'call') {
    if (positional.length !== 1) throw new Error('Usage: doneline call TOOL --input FILE (or --stdin).')
    operations = [{ tool: positional[0], args: objectInput(await readInput(options)) }]
  } else if (command === 'batch') {
    if (positional.length) throw new Error('Usage: doneline batch --input FILE (or --stdin).')
    const input = await readInput(options)
    if (!Array.isArray(input) || !input.length || input.length > 100) throw new Error('Batch input must contain 1–100 operations.')
    operations = input.map(item => {
      const entry = objectInput(item)
      if (typeof entry.tool !== 'string' || !entry.tool) throw new Error('Each batch operation needs a tool name.')
      return { tool: entry.tool, args: objectInput(entry.args ?? {}) }
    })
  } else if (command !== 'tools') {
    if (['input', 'json', 'stdin'].some(key => options.has(key))) throw new Error('JSON input is supported by call and batch.')
    const args: ObjectInput = person === undefined ? {} : { person_id: person }
    let tool = command
    if (['today', 'day', 'week'].includes(command)) {
      if (positional.length > 1 || (command === 'today' && positional.length)) throw new Error('Use day or week with one YYYY-MM-DD date.')
      tool = command === 'week' ? 'plan_week' : 'plan_day'
      if (positional[0]) args[command === 'week' ? 'from_day' : 'day'] = positional[0]
    } else if (command === 'search') {
      if (!positional.length) throw new Error('Usage: doneline search WORDS.')
      args.query = positional.join(' ')
      if (options.has('limit')) args.limit = Number(options.get('limit'))
    } else {
      if (positional.length) throw new Error(`${command} does not take positional arguments.`)
      if (command === 'sync') tool = 'sync_workspace'
    }
    operations = [{ tool, args }]
  }
  const server = options.has('server') ? path.resolve(String(options.get('server'))) : path.join(__dirname, 'server.cjs')
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  if (options.has('data-dir')) {
    env.DONELINE_DIR = path.resolve(String(options.get('data-dir')))
    delete env.DONELINE_DB
  }
  const client = new Client({ name: 'doneline-cli', version })
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], env, stderr: 'pipe' })
  // Keep stdout machine-readable and drain stderr without publishing account details.
  transport.stderr?.on('data', () => {})
  try {
    await client.connect(transport, { timeout: timeoutSeconds * 1000 })
    const tools = (await client.listTools()).tools
    if (command === 'tools') {
      if (positional.length > 1) throw new Error('Usage: doneline tools [TOOL].')
      const selected = positional.length ? tools.filter(tool => tool.name === positional[0]) : tools
      if (!selected.length) throw new Error('Tool not found.')
      console.log(JSON.stringify({ ok: true, tools: selected }, null, 2))
      return
    }
    // Resolve every name before starting a batch, preventing typo-driven partial plans.
    for (const operation of operations) if (!tools.some(tool => tool.name === operation.tool)) throw new Error(`Tool not found: ${operation.tool}. Run doneline tools.`)
    const results = []
    for (const operation of operations) {
      try {
        const response = await client.callTool({ name: operation.tool, arguments: operation.args }, undefined, { timeout: timeoutSeconds * 1000 })
        const structured = response.structuredContent as ObjectInput | undefined
        let data: unknown = structured?.result
        if (data === undefined) {
          const blocks = Array.isArray(response.content) ? response.content : []
          const first = blocks.find((item: unknown) => !!item && typeof item === 'object' && 'type' in item && item.type === 'text' && 'text' in item && typeof item.text === 'string') as { text: string } | undefined
          if (first) { try { data = JSON.parse(first.text) } catch { data = first.text } }
        }
        results.push({ ok: !response.isError, tool: operation.tool, data, ...(structured?.local_receipt ? { local_receipt: structured.local_receipt } : {}) })
        if (response.isError) { process.exitCode = 1; break }
      } catch (error) {
        results.push({ ok: false, tool: operation.tool, error: error instanceof Error ? error.message : 'Tool call failed.', completion_unknown: true })
        process.exitCode = 1
        break
      }
    }
    console.log(JSON.stringify(command === 'batch' ? { ok: !process.exitCode, completed: results.filter(result => result.ok).length, results } : results[0], null, 2))
  } finally { await client.close() }
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Doneline command failed.' }))
  process.exitCode = 1
})
