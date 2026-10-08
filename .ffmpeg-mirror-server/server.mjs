import { createServer } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { join, normalize } from 'node:path'

const ROOT = '/srv'

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
  const file = join(ROOT, rel)
  if (!file.startsWith(ROOT)) {
    res.writeHead(403)
    res.end()
    return
  }
  let st
  try {
    st = statSync(file)
  } catch {
    res.writeHead(404)
    res.end('not found')
    return
  }
  if (st.isDirectory()) {
    res.writeHead(403)
    res.end()
    return
  }
  let start = 0
  let end = st.size - 1
  let code = 200
  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    if (m) {
      if (m[1]) start = Number(m[1])
      if (m[2]) end = Number(m[2])
      code = 206
    }
  }
  if (end >= st.size) end = st.size - 1
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
  }
  if (code === 206) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`
  res.writeHead(code, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(file, { start, end }).pipe(res)
}).listen(8471, '0.0.0.0', () => console.log('ffmpeg mirror ready'))
