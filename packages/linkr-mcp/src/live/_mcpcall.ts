import { spawn } from 'node:child_process'
const calls = JSON.parse(process.argv[2]) as { name: string; arguments: Record<string, unknown> }[]
const child = spawn('npx', ['tsx', '--tsconfig', 'tsconfig.json', 'src/live/server.ts'], { stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''; const waiters = new Map<number, (m: any) => void>()
child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(l); waiters.get(m.id)?.(m) } })
let id = 0
const rpc = (method: string, params: unknown) => new Promise<any>((res) => { const n = ++id; waiters.set(n, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n') })
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } })
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
for (const c of calls) {
  const r = await rpc('tools/call', c)
  console.log(`--- ${c.name}${r.result?.isError ? ' [ERROR]' : ''}`)
  for (const x of r.result?.content ?? [r.error]) console.log(x?.type === 'resource' ? `RESOURCE ${x.resource.uri} ${x.resource.text.length} chars` : (x?.text ?? JSON.stringify(x)).slice(0, 700))
}
child.kill()
