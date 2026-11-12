import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

export const DATA_DIR = path.join(os.homedir(), '.podwave')
export const COVERS_DIR = path.join(DATA_DIR, 'covers')
const STATE_FILE = path.join(DATA_DIR, 'state.json')

const DEFAULT_STATE = {
  folders: [],
  progress: {},
  settings: { rate: 1, volume: 0.9, lastEpisodeId: null },
}

let state = structuredClone(DEFAULT_STATE)
let saveTimer = null
let saveChain = Promise.resolve()

export async function initState() {
  await fsp.mkdir(DATA_DIR, { recursive: true })
  await fsp.mkdir(COVERS_DIR, { recursive: true })
  try {
    const raw = await fsp.readFile(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    state = {
      ...structuredClone(DEFAULT_STATE),
      ...parsed,
      settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
    }
  } catch {
    // First run, or the file was removed by the user.
  }
  return state
}

export function getState() {
  return state
}

export function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    flushState().catch((err) => console.error('[podwave] failed to save state:', err.message))
  }, 250)
}

export function flushState() {
  saveChain = saveChain.then(async () => {
    const tmp = `${STATE_FILE}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2))
    await fsp.rename(tmp, STATE_FILE)
  })
  return saveChain
}

export async function closeState() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  await flushState()
}

export function updateState(patch) {
  state = { ...state, ...patch }
  scheduleSave()
}

export function setProgress(id, position, duration) {
  state.progress = {
    ...state.progress,
    [id]: { position, duration, updatedAt: Date.now() },
  }
  scheduleSave()
}

export function setSettings(patch) {
  state.settings = { ...state.settings, ...patch }
  scheduleSave()
}

export function addFolderState(folder) {
  if (state.folders.includes(folder)) return
  state.folders = [...state.folders, folder]
  scheduleSave()
}

export function removeFolderState(folder) {
  state.folders = state.folders.filter((entry) => entry !== folder)
  scheduleSave()
}

export function removeProgressFor(predicate) {
  const next = {}
  for (const [id, value] of Object.entries(state.progress)) {
    if (!predicate(id)) next[id] = value
  }
  state.progress = next
  scheduleSave()
}

export function stateFileExists() {
  return fs.existsSync(STATE_FILE)
}
