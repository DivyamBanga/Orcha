import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { is } from '@electron-toolkit/utils'
import { IPC } from '../../shared/ipc'
import type { ArtifactSnapshot } from '../../shared/types'

// Windows besides the main one, drawn by the same renderer bundle: an
// artifact popped out on its own, and a chat laid out for print (to PDF).

function load(window: BrowserWindow, query: Record<string, string>): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${new URLSearchParams(query)}`)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }
}

const preferences = (): Electron.WebPreferences => ({
  preload: join(__dirname, '../preload/index.js'),
  sandbox: false
})

// Popped-out artifacts, by window, until the window closes.
const snapshots = new Map<string, ArtifactSnapshot>()

export function popOutArtifact(artifact: ArtifactSnapshot): void {
  const id = randomUUID()
  snapshots.set(id, artifact)
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 420,
    minHeight: 320,
    title: artifact.title,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#09090b' : '#fcfcfd',
    webPreferences: preferences()
  })
  window.on('closed', () => snapshots.delete(id))
  load(window, { popout: id })
}

export function artifactSnapshot(id: string): ArtifactSnapshot | null {
  return snapshots.get(id) ?? null
}

// Lays the chat out in a hidden window, waits for it to say it has drawn
// (maths and code included), and prints that to a PDF.
export async function chatToPdf(chatId: string, path: string): Promise<void> {
  const window = new BrowserWindow({
    show: false,
    width: 860,
    height: 1100,
    webPreferences: preferences()
  })
  try {
    const drawn = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The chat took too long to lay out.')),
        20_000
      )
      const done = (e: Electron.IpcMainEvent): void => {
        if (e.sender !== window.webContents) return
        clearTimeout(timer)
        ipcMain.off(IPC.PrintReady, done)
        resolve()
      }
      ipcMain.on(IPC.PrintReady, done)
    })
    load(window, { print: chatId })
    await drawn
    const pdf = await window.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'custom', top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 }
    })
    writeFileSync(path, pdf)
  } finally {
    window.destroy()
  }
}
