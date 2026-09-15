#!/usr/bin/env node
/**
 * One command to get GrassAssassin running on a real phone.
 *
 * The app already resolves its API URL from Metro's host, so a phone running
 * Expo Go points itself at this machine automatically. Everything around that
 * was a page of README steps, and the step people miss is always the same one:
 * the API advertises itself as `localhost` by default, and on a phone
 * localhost is the phone. Photo upload is the thing that breaks, ten minutes
 * in, for a reason nobody can see.
 *
 * Usage:
 *   pnpm demo                  # check everything, then start the API and Expo
 *   pnpm demo --check          # say what is missing, start nothing
 *   pnpm demo --host 1.2.3.4   # override the detected LAN address
 *
 * Nothing starts until every precondition passes, so a half-started stack is
 * not a state this can leave behind.
 */
import { networkInterfaces } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const valueOf = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 ? argv[i + 1] : undefined
}

const CHECK_ONLY = flag('check')
const API_PORT = 4000
const ESC = String.fromCharCode(27)

const colour = process.stdout.isTTY && !process.env['NO_COLOR']
const paint = (code, text) => (colour ? `${ESC}[${code}m${text}${ESC}[0m` : text)
const bold = (t) => paint('1', t)
const green = (t) => paint('32', t)
const red = (t) => paint('31', t)
const yellow = (t) => paint('33', t)
const dim = (t) => paint('2', t)

const problems = []

const ok = (label, detail = '') =>
  console.log(`  ${green('OK')}   ${label}${detail ? ` ${dim(detail)}` : ''}`)
const bad = (label, fix) => {
  console.log(`  ${red('MISS')} ${label}`)
  problems.push({ label, fix })
}
const warn = (label, detail = '') =>
  console.log(`  ${yellow('NOTE')} ${label}${detail ? ` ${dim(detail)}` : ''}`)

/**
 * The address a phone on the same wifi can reach this machine at.
 *
 * Loopback is useless — on a phone, localhost is the phone. So are the virtual
 * interfaces Docker, VPNs and virtualisation software leave lying around: a
 * phone cannot route to a docker bridge. Requiring a private range keeps this
 * from confidently returning a public or documentation address, which is worse
 * than returning nothing because it looks right and fails later.
 */
export function lanAddress(interfaces = networkInterfaces()) {
  const candidates = []
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (/^(docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|tap|awdl|llw|zt)/i.test(name)) continue
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      candidates.push({ name, address: address.address })
    }
  }

  const isPrivate = (ip) =>
    /^10\./.test(ip)
    || /^192\.168\./.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)

  const wifiOrEthernet = (name) => /^(en|eth|wl|wlan|wi-?fi|ethernet)/i.test(name)

  return candidates.find((x) => wifiOrEthernet(x.name) && isPrivate(x.address))
    ?? candidates.find((x) => isPrivate(x.address))
    ?? null
}

/** Whether something is listening, without needing a client for each protocol. */
function portOpen(port, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host })
    const done = (result) => { socket.destroy(); resolve(result) }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function readEnvFile() {
  const file = join(ROOT, 'apps/api/.env')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

function fromEnvFile(key, env = readEnvFile()) {
  const line = env.split('\n').find((l) => l.startsWith(`${key}=`))
  return line ? line.slice(key.length + 1).trim() : null
}

const run = (command, args, options = {}) =>
  spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options })

async function main() {
  console.log(`\n${bold('GrassAssassin - demo on a phone')}\n`)

  const override = valueOf('host')
  const found = override ? { name: 'override', address: override } : lanAddress()

  if (!found) {
    bad(
      'No LAN address found on this machine.',
      'Join a wifi network, or pass one: pnpm demo --host 192.168.1.42',
    )
  } else if (override) {
    ok('Using the address you gave', found.address)
  } else {
    ok('This machine is reachable at', `${found.address} (${found.name})`)
  }

  const apiUrl = found ? `http://${found.address}:${API_PORT}` : null

  const major = Number(process.versions.node.split('.')[0])
  if (major >= 20) ok('Node', process.versions.node)
  else bad(`Node ${process.versions.node} is too old.`, 'Install Node 20 or newer.')

  if (run('pnpm', ['--version'], { stdio: 'ignore' }).status === 0) ok('pnpm')
  else bad('pnpm is not installed.', 'npm install -g pnpm')

  if (existsSync(join(ROOT, 'node_modules'))) ok('Dependencies installed')
  else bad('Dependencies are not installed.', 'pnpm install')

  const env = readEnvFile()
  const url = process.env['DATABASE_URL'] ?? fromEnvFile('DATABASE_URL', env)
  if (!url) {
    bad(
      'No DATABASE_URL.',
      'cp .env.example apps/api/.env, then: docker compose up -d db redis',
    )
  } else {
    let parsed = null
    try { parsed = new URL(url) } catch { /* malformed */ }
    const port = Number(parsed?.port || 5432)
    if (!parsed) {
      bad('DATABASE_URL is not a valid URL.', 'Check apps/api/.env')
    } else if (await portOpen(port, parsed.hostname)) {
      ok('Database reachable', `${parsed.hostname}:${port}`)
    } else {
      bad(
        `Nothing is listening on ${parsed.hostname}:${port}.`,
        'Start one: docker compose up -d db redis',
      )
    }
  }

  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
    const secret = process.env[key] ?? fromEnvFile(key, env) ?? ''
    if (secret.length >= 32) ok(key)
    else bad(`${key} is missing or under 32 characters.`, 'Set it in apps/api/.env')
  }

  if (await portOpen(API_PORT)) {
    warn(
      `Something is already listening on :${API_PORT}.`,
      'If that is the API, fine. If not, stop it first.',
    )
  } else {
    ok(`Port ${API_PORT} is free`)
  }

  if (!process.env['STRIPE_SECRET_KEY'] && !fromEnvFile('STRIPE_SECRET_KEY', env)) {
    warn('No Stripe key, so payments use the in-memory fake.', 'The whole money flow still runs.')
  }
  if ((process.env['PUSH_ENABLED'] ?? fromEnvFile('PUSH_ENABLED', env)) !== 'true') {
    warn('Push is off, so notifications are recorded but not delivered.', 'PUSH_ENABLED=true sends them.')
  }

  console.log('')

  if (problems.length > 0) {
    console.log(red(bold(`${problems.length} thing${problems.length === 1 ? '' : 's'} to fix first:\n`)))
    for (const problem of problems) {
      console.log(`  ${red('-')} ${problem.label}`)
      if (problem.fix) console.log(`    ${dim(problem.fix)}`)
    }
    console.log('')
    process.exit(1)
  }

  console.log(green(bold('Everything checks out.')))
  console.log(`\n  The API will advertise itself as ${bold(apiUrl)}`)
  console.log(dim('  Photo upload needs that - on a phone, "localhost" is the phone.'))

  if (CHECK_ONLY) {
    console.log(`\n${dim('--check given, so nothing was started.')}\n`)
    return
  }

  console.log(`\n${bold('Preparing the database...')}`)
  for (const [label, script] of [
    ['Generating the Prisma client', 'db:generate'],
    ['Applying migrations', 'db:deploy'],
    ['Seeding demo data', 'db:seed'],
  ]) {
    if (run('pnpm', ['--filter', '@grassassassin/api', script]).status !== 0) {
      console.log(red(`\n${label} failed. Nothing was started.\n`))
      process.exit(1)
    }
  }

  console.log(`\n${bold('Starting the API...')}`)
  const api = spawn('pnpm', ['--filter', '@grassassassin/api', 'dev'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PUBLIC_BASE_URL: apiUrl },
  })

  const stop = () => { api.kill('SIGINT'); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  for (let i = 0; i < 40 && !(await portOpen(API_PORT)); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!(await portOpen(API_PORT))) {
    console.log(red('\nThe API did not come up. Its output is above.\n'))
    api.kill('SIGINT')
    process.exit(1)
  }

  console.log(`
${green(bold('  Ready.'))}

  ${bold('On your phone:')}
    1. Install ${bold('Expo Go')} from the App Store or Play Store.
    2. Put the phone on the ${bold('same wifi')} as this machine.
    3. Scan the QR code below. iPhone: the Camera app. Android: Expo Go itself.

  ${bold('Sign in as:')}
    customer1@grassassassin.test   ${dim('post a job, approve the work, pay')}
    worker1@grassassassin.test     ${dim('claim jobs, get paid, climb the ranks')}
    Password for both: ${bold('GrassDemo123!')}

  ${dim('Ctrl-C stops everything.')}
`)

  /*
   * EXPO_NO_TYPESCRIPT_SETUP, because `expo start` otherwise rewrites
   * apps/mobile/tsconfig.json on first run — adding `extends:
   * expo/tsconfig.base`, which changes how this workspace's packages are
   * typechecked and breaks `pnpm typecheck` with a dozen
   * exactOptionalPropertyTypes errors. Finding that after a demo, in a file
   * you did not edit, is a bad first hour with a codebase.
   */
  const expo = spawn('pnpm', ['--filter', '@grassassassin/mobile', 'exec', 'expo', 'start'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      EXPO_PUBLIC_API_URL: apiUrl,
      EXPO_NO_TYPESCRIPT_SETUP: '1',
    },
  })

  expo.on('exit', () => { api.kill('SIGINT'); process.exit(0) })
}

// Only when invoked directly, so lanAddress() can be tested without starting a stack.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
