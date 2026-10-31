import { api, ApiError, type Asset, type Policy } from './api'
import { message, say } from './messages'
import { refresh } from './query'
import { createStore } from './store'

export type UploadState = 'waiting' | 'starting' | 'uploading' | 'done' | 'failed' | 'cancelled'

export type Upload = {
  key: string
  name: string
  size: number
  sent: number
  /** Bytes per second, smoothed. */
  speed: number
  state: UploadState
  libraryId: string
  library: string
  /** The folder's name; null is Home. */
  folder: string | null
  assetId?: string
  /** Who can watch it; the dock's choice for the batch. */
  policy: Policy
  /** The video once it exists, for its link and embed code. */
  link?: Asset
  problem?: string
}

export type UploadTarget = { policy: Policy; libraryId: string; library: string; folderId: string | null; folder: string | null }

// Uploads outlive page changes inside the app, so they live in one shared list.
export const uploads = createStore<Upload[]>([])

// The workspace's largest upload (GET /v1/me), set when the console loads; files above it are refused before sending.
let maxBytes = 0
export const setUploadLimit = (n: number) => void (maxBytes = n)
const AT_ONCE = 3
const running = (u: Upload) => u.state === 'starting' || u.state === 'uploading'
export const isRunning = () => uploads.get().some(running)

// Files and requests in flight are not state to render, so they stay out of the store.
type Job = { file: File; target: UploadTarget; url?: string; xhr?: XMLHttpRequest; stopped?: boolean; at: number; mark: number }
const jobs = new Map<string, Job>()

const PART = 64 * 1024 ** 2
const RETRY_DELAYS = [0, 2000, 5000, 10000, 30000]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Progress = { received: number; size: number | null; complete: boolean }

/** One part of the file, PUT with Content-Range; reports bytes as they leave. */
function sendPart(job: Job, from: number, onSent: (n: number) => void): Promise<Progress> {
  const to = Math.min(from + PART, job.file.size)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    job.xhr = xhr
    xhr.open('PUT', job.url!)
    xhr.setRequestHeader('Content-Range', `bytes ${from}-${to - 1}/${job.file.size}`)
    xhr.upload.onprogress = (e) => onSent(from + e.loaded)
    xhr.onload = () => {
      let data: { error?: { code?: string; message?: string } } | null = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        // an answer that isn't JSON (a proxy's error page) is just its status
      }
      if (xhr.status === 200 && data) resolve(data as Progress)
      else reject(new ApiError(data?.error?.code ?? 'internal', xhr.status, data?.error?.message ?? ''))
    }
    xhr.onerror = xhr.onabort = () => reject(new ApiError('network', 0))
    xhr.send(job.file.slice(from, to))
  })
}

// Worth another try: the connection, our side, or a part that was busy or out of step (GET resyncs it). Not an expired
// upload or a file that is too large.
const retryable = (err: unknown) => !(err instanceof ApiError) || err.status === 0 || err.status === 409 || err.status >= 500

/** Sends the file in parts from wherever the upload stopped (GET says), retrying a broken part after a pause. */
async function sendFile(job: Job, onSent: (n: number) => void) {
  let tries = 0
  for (;;) {
    if (job.stopped) return
    try {
      let at = (await api<Progress>('GET', new URL(job.url!).pathname)).received
      for (;;) {
        const p = await sendPart(job, at, onSent)
        if (p.complete) return
        at = p.received
        tries = 0
      }
    } catch (err) {
      if (job.stopped) return
      if (!retryable(err) || tries >= RETRY_DELAYS.length) throw err
      await sleep(RETRY_DELAYS[tries++])
    }
  }
}

const patch = (key: string, p: Partial<Upload>) => uploads.set((l) => l.map((u) => (u.key === key ? { ...u, ...p } : u)))

/** Queue files; three go at a time, the rest wait their turn. */
export function addUploads(files: File[], target: UploadTarget) {
  const rows = files.map((file) => {
    const key = crypto.randomUUID()
    jobs.set(key, { file, target, at: 0, mark: 0 })
    return { key, name: file.name, size: file.size, sent: 0, speed: 0, state: 'waiting', libraryId: target.libraryId, library: target.library, folder: target.folder, policy: target.policy } as Upload
  })
  uploads.set((l) => [...l, ...rows])
  pump()
}

function pump() {
  const list = uploads.get()
  let free = AT_ONCE - list.filter(running).length
  for (const u of list) {
    if (free <= 0) break
    if (u.state === 'waiting') (free--, void run(u.key))
  }
}

/** Reserve an upload, create its video in a library and folder, then send the bytes in parts so a dropped connection resumes. */
async function run(key: string) {
  const job = jobs.get(key)
  if (!job) return
  const { file } = job
  patch(key, { state: 'starting', problem: undefined })
  if (maxBytes && file.size > maxBytes) return fail(key, say('upload_too_large'))
  try {
    job.stopped = false
    if (!job.url) {
      const reserved = await api<{ id: string; upload_url: string }>('POST', '/v1/uploads')
      const asset = await api<Asset>('POST', '/v1/assets', {
        upload_id: reserved.id,
        passthrough: file.name.slice(0, 255),
        title: file.name.replace(/\.[^.]+$/, '').slice(0, 200),
        playback_policy: job.target.policy,
        library_id: job.target.libraryId,
        folder_id: job.target.folderId ?? 'root',
      })
      if (uploads.get().find((u) => u.key === key)?.state === 'cancelled') return void api('DELETE', `/v1/assets/${asset.id}`).catch(() => {})
      // The dock's choice may have changed while this video was being made.
      const want = job.target.policy
      const link = asset.playback_policy === want ? asset : await api<Asset>('PATCH', `/v1/assets/${asset.id}`, { playback_policy: want })
      patch(key, { assetId: asset.id, link })
      void refresh('/v1/assets', '/v1/libraries')
      job.url = reserved.upload_url
    }
    job.at = 0
    await sendFile(job, (sent) => {
      const now = Date.now()
      const was = uploads.get().find((u) => u.key === key)
      if (job.at && now > job.at) {
        const rate = ((sent - job.mark) / (now - job.at)) * 1000
        patch(key, { speed: was?.speed ? was.speed * 0.7 + rate * 0.3 : rate })
      }
      job.at = now
      job.mark = sent
      patch(key, { state: 'uploading', sent })
    })
    if (job.stopped) return
    patch(key, { state: 'done', sent: file.size, speed: 0 })
    jobs.delete(key)
    void refresh('/v1/assets', '/v1/libraries')
    pump()
  } catch (err) {
    fail(key, err instanceof ApiError && (err.status === 0 || err.status >= 500) ? 'The upload stopped. Check your connection, then try again.' : message(err))
  }
}

function fail(key: string, problem: string) {
  patch(key, { state: 'failed', problem, speed: 0 })
  pump()
}

/** Stop one file; the video made for it is removed so no empty one is left behind. */
export function cancelUpload(key: string) {
  const u = uploads.get().find((x) => x.key === key)
  if (!u || !(running(u) || u.state === 'waiting')) return
  const job = jobs.get(key)
  patch(key, { state: 'cancelled', speed: 0, sent: 0, assetId: undefined })
  if (job) {
    job.stopped = true
    job.xhr?.abort()
    job.url = undefined // the file stays, so Try again starts it afresh
  }
  if (u.assetId) {
    void api('DELETE', `/v1/assets/${u.assetId}`)
      .catch(() => {})
      .finally(() => void refresh('/v1/assets', '/v1/libraries'))
  }
  pump()
}

export function cancelAll() {
  for (const u of uploads.get()) cancelUpload(u.key)
}

/** A failed file carries on from where it stopped; a cancelled one starts again. */
export function retryUpload(key: string) {
  patch(key, { state: 'waiting', problem: undefined })
  pump()
}

export const removeUpload = (key: string) => (jobs.delete(key), uploads.set((l) => l.filter((u) => u.key !== key)))
export const clearUploads = () => uploads.set((l) => l.filter((u) => running(u) || u.state === 'waiting'))

/** Who can watch every upload in the dock: files not yet created take it at creation, the others are changed in place. */
export async function setUploadsPolicy(policy: Policy): Promise<boolean> {
  const list = uploads.get().filter((u) => u.policy !== policy)
  uploads.set((l) => l.map((u) => ({ ...u, policy })))
  for (const u of list) {
    const job = jobs.get(u.key)
    if (job) job.target = { ...job.target, policy }
  }
  const made = list.filter((u) => u.assetId)
  const results = await Promise.allSettled(made.map((u) => api<Asset>('PATCH', `/v1/assets/${u.assetId}`, { playback_policy: policy })))
  results.forEach((r, i) => r.status === 'fulfilled' && patch(made[i].key, { link: r.value }))
  void refresh('/v1/assets')
  return results.every((r) => r.status === 'fulfilled')
}
