import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { parseFile } from 'music-metadata'
import { COVERS_DIR, getState } from './state.js'

export const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.m4b', '.aac', '.wav', '.flac', '.ogg', '.oga', '.opus', '.weba', '.webm', '.wma',
])

const SCAN_DEPTH = 6
const PARSE_CONCURRENCY = 6

let episodes = []
const byId = new Map()
const metaCache = new Map()
let scanPromise = null
let scanState = { running: false, startedAt: null, finishedAt: null, error: null }

export function expandHome(input) {
  const value = String(input || '').trim()
  if (!value) return ''
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return path.resolve(value)
}

export function episodeId(filePath) {
  return crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16)
}

function isInside(parent, child) {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

async function walk(dir, depth, files) {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < SCAN_DEPTH) await walk(full, depth + 1, files)
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(full)
    }
  }
}

async function readEpisode(file) {
  const stat = await fsp.stat(file)
  const id = episodeId(file)
  const cacheKey = `${stat.mtimeMs}:${stat.size}`
  const cached = metaCache.get(id)
  if (cached && cached.key === cacheKey) {
    return { ...cached.data, size: stat.size, mtime: stat.mtimeMs }
  }

  let title = path.basename(file, path.extname(file))
  let artist = path.basename(path.dirname(file))
  let album = ''
  let duration = null
  let hasCover = false

  try {
    const parsed = await parseFile(file, { duration: true, skipCovers: false })
    const common = parsed.common || {}
    if (common.title) title = common.title
    if (common.artist) artist = common.artist
    else if (common.albumartist) artist = common.albumartist
    if (common.album) album = common.album
    if (parsed.format && parsed.format.duration) duration = parsed.format.duration

    const picture = common.picture && common.picture[0]
    if (picture && picture.data) {
      const ext = /png/i.test(picture.format || '') ? 'png' : 'jpg'
      const coverPath = path.join(COVERS_DIR, `${id}.${ext}`)
      try {
        await fsp.access(coverPath)
      } catch {
        await fsp.writeFile(coverPath, picture.data)
      }
      hasCover = true
    }
  } catch {
    // Damaged or unsupported tags: fall back to the file name.
  }

  const data = {
    id,
    title,
    artist,
    album,
    duration,
    hasCover,
    folder: path.dirname(file),
    file,
  }
  metaCache.set(id, { key: cacheKey, data })
  return { ...data, size: stat.size, mtime: stat.mtimeMs }
}

async function doScan() {
  const folders = getState().folders
  scanState = { running: true, startedAt: Date.now(), finishedAt: null, error: null }

  const files = []
  for (const folder of folders) {
    try {
      const stat = await fsp.stat(folder)
      if (!stat.isDirectory()) continue
    } catch {
      continue
    }
    await walk(folder, 0, files)
  }

  const unique = []
  const seen = new Set()
  for (const file of files) {
    let real = file
    try {
      real = await fsp.realpath(file)
    } catch {
      /* keep the original path */
    }
    if (seen.has(real)) continue
    seen.add(real)
    unique.push(real)
  }

  const items = []
  let cursor = 0
  async function worker() {
    while (cursor < unique.length) {
      const file = unique[cursor]
      cursor += 1
      try {
        items.push(await readEpisode(file))
      } catch {
        /* skip unreadable files */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARSE_CONCURRENCY, unique.length || 1) }, worker))

  items.sort((a, b) => b.mtime - a.mtime)
  episodes = items
  byId.clear()
  for (const episode of episodes) byId.set(episode.id, episode)

  scanState = { running: false, startedAt: scanState.startedAt, finishedAt: Date.now(), error: null }
  return episodes
}

export function scanLibrary() {
  if (scanPromise) return scanPromise
  scanPromise = doScan()
    .catch((error) => {
      scanState = { running: false, startedAt: scanState.startedAt, finishedAt: Date.now(), error: error.message }
      throw error
    })
    .finally(() => {
      scanPromise = null
    })
  return scanPromise
}

export function isScanning() {
  return Boolean(scanPromise)
}

export function getScanState() {
  return scanState
}

export function getEpisode(id) {
  return byId.get(id) || null
}

export function getEpisodes() {
  return episodes.map(({ file, folder, ...rest }) => ({
    ...rest,
    // Only expose the last two path segments to the client.
    location: folder.split(path.sep).slice(-2).join('/'),
  }))
}

export function getCoverPath(id) {
  for (const ext of ['jpg', 'png', 'webp']) {
    const candidate = path.join(COVERS_DIR, `${id}.${ext}`)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

export async function addFolder(rawPath) {
  const expanded = expandHome(rawPath)
  if (!expanded) {
    const error = new Error('文件夹路径不能为空')
    error.status = 400
    throw error
  }
  let real
  try {
    const stat = await fsp.stat(expanded)
    if (!stat.isDirectory()) {
      const error = new Error('不是一个文件夹')
      error.status = 400
      throw error
    }
    real = await fsp.realpath(expanded)
  } catch (err) {
    if (err.status) throw err
    const error = new Error('文件夹不存在或不可读')
    error.status = 400
    throw error
  }

  const folders = getState().folders
  if (folders.includes(real)) return real
  const duplicate = folders.find((entry) => isInside(entry, real) || isInside(real, entry))
  if (duplicate) {
    const error = new Error(`与已添加的文件夹重叠：${duplicate}`)
    error.status = 409
    throw error
  }
  return real
}

export function forgetEpisodesUnder(folder) {
  const removed = new Set()
  for (const episode of episodes) {
    if (episode.file === folder || isInside(folder, episode.file)) removed.add(episode.id)
  }
  return removed
}
