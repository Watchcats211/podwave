import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  initState, getState, setProgress, setSettings, removeProgressFor, closeState,
  addFolderState, removeFolderState,
} from './state.js'
import {
  getEpisode, getEpisodes, getCoverPath, getScanState, isScanning, scanLibrary,
  addFolder, expandHome, forgetEpisodesUnder,
} from './library.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HOST = '127.0.0.1'
const PORT = Number(process.env.PODWAVE_PORT || 4780)
const WEB_DIST = path.join(__dirname, '..', 'web', 'dist')

const MIME = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.weba': 'audio/webm',
  '.webm': 'audio/webm',
  '.wma': 'audio/x-ms-wma',
}

const app = express()
app.use(express.json({ limit: '100kb' }))
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  next()
})

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'podwave', version: '0.1.0' })
})

app.get('/api/state', (req, res) => {
  const state = getState()
  res.json({
    folders: state.folders,
    settings: state.settings,
  })
})

app.get('/api/episodes', (req, res) => {
  const state = getState()
  res.json({
    items: getEpisodes(),
    folders: state.folders,
    progress: state.progress,
    scan: getScanState(),
  })
})

app.post('/api/scan', (req, res) => {
  scanLibrary().catch((error) => console.error('[podwave] scan failed:', error.message))
  res.json({ scan: getScanState() })
})

app.post('/api/folders', async (req, res, next) => {
  try {
    const input = req.body && req.body.path
    const folder = await addFolder(input)
    addFolderState(folder)
    scanLibrary().catch((error) => console.error('[podwave] scan failed:', error.message))
    res.json({ folder, folders: getState().folders })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/folders', (req, res) => {
  const input = (req.body && req.body.path) || req.query.path
  const target = expandHome(input)
  if (!target) return res.status(400).json({ error: '缺少文件夹路径' })
  const folders = getState().folders
  const next = folders.filter((folder) => folder !== target)
  if (next.length === folders.length) return res.status(404).json({ error: '文件夹不在列表中' })

  const removed = forgetEpisodesUnder(target)
  removeProgressFor((id) => removed.has(id))
  removeFolderState(target)
  scanLibrary().catch((error) => console.error('[podwave] scan failed:', error.message))
  res.json({ folders: next })
})

app.get('/api/episodes/:id/cover', (req, res) => {
  const episode = getEpisode(req.params.id)
  const cover = episode ? getCoverPath(episode.id) : null
  if (!cover) return res.status(404).end()
  res.setHeader('Cache-Control', 'public, max-age=86400')
  res.sendFile(cover)
})

app.get('/api/episodes/:id/audio', (req, res, next) => {
  const episode = getEpisode(req.params.id)
  if (!episode) return res.status(404).json({ error: '单集不存在' })

  let stat
  try {
    stat = fs.statSync(episode.file)
  } catch {
    return res.status(410).json({ error: '文件已不存在' })
  }

  const type = MIME[path.extname(episode.file).toLowerCase()] || 'application/octet-stream'
  const total = stat.size
  const range = req.headers.range

  if (!range) {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    })
    fs.createReadStream(episode.file).pipe(res)
    return
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim())
  if (!match || (match[1] === '' && match[2] === '')) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` })
    res.end()
    return
  }

  let start
  let end
  if (match[1] === '') {
    const suffix = Number(match[2])
    start = Math.max(0, total - suffix)
    end = total - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` })
    res.end()
    return
  }

  res.writeHead(206, {
    'Content-Type': type,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  })
  fs.createReadStream(episode.file, { start, end }).pipe(res)
})

app.put('/api/progress/:id', (req, res) => {
  const episode = getEpisode(req.params.id)
  if (!episode) return res.status(404).json({ error: '单集不存在' })
  const position = Number(req.body && req.body.position)
  const duration = Number(req.body && req.body.duration) || episode.duration || 0
  if (!Number.isFinite(position) || position < 0) {
    return res.status(400).json({ error: '位置无效' })
  }
  setProgress(episode.id, Math.round(position * 10) / 10, duration)
  res.json({ ok: true })
})

app.patch('/api/settings', (req, res) => {
  const body = req.body || {}
  const patch = {}
  if (Number.isFinite(Number(body.rate))) patch.rate = Math.min(3, Math.max(0.5, Number(body.rate)))
  if (Number.isFinite(Number(body.volume))) patch.volume = Math.min(1, Math.max(0, Number(body.volume)))
  if (typeof body.lastEpisodeId === 'string' || body.lastEpisodeId === null) patch.lastEpisodeId = body.lastEpisodeId
  setSettings(patch)
  res.json({ settings: getState().settings })
})

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' })
  next()
})

if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST, { index: false }))
  app.get('*', (req, res) => {
    res.sendFile(path.join(WEB_DIST, 'index.html'))
  })
}

app.use((error, req, res, next) => {
  const status = error.status || 500
  if (status >= 500) console.error('[podwave]', error)
  res.status(status).json({ error: error.message || '服务器错误' })
})

async function main() {
  await initState()
  app.listen(PORT, HOST, () => {
    console.log(`[podwave] listening on http://${HOST}:${PORT}`)
    console.log(`[podwave] data dir: ~/.podwave`)
  })
  if (getState().folders.length) {
    scanLibrary().catch((error) => console.error('[podwave] initial scan failed:', error.message))
  }
  const shutdown = async () => {
    await closeState()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error('[podwave] failed to start:', error)
  process.exit(1)
})
