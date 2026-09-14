/**
 * Static server with SPA fallback, for the exported Expo web build.
 *
 * Expo Router uses real paths, so /map has to serve index.html rather than 404.
 * Any plain static server gets this wrong and every deep link looks broken.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? '.web')
const port = Number(process.env.PORT ?? 4311)

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
}

http.createServer((request, response) => {
  const requested = decodeURIComponent((request.url ?? '/').split('?')[0])
  const candidate = path.join(root, requested)

  // Refuse to serve outside the root, however the path is spelled.
  const file = candidate.startsWith(root) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate
    : path.join(root, 'index.html')

  response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(response)
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`))
