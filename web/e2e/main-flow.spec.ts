import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

// The main flow a new person takes, against a running API and worker: sign up, upload a video, wait for it to be
// processed, and watch it play on its watch page.
test('sign up, upload, process and play a video', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const clip = join(mkdtempSync(join(tmpdir(), 'clip-')), 'sample.mp4')
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '6', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', clip])

  await page.goto('/signup')
  await page.getByLabel('Your name').fill('Ada Lovelace')
  await page.getByLabel('Organisation').fill('Analytical Films')
  await page.getByLabel('Email').fill(`ada-${Date.now()}@example.test`)
  await page.getByLabel('Password').fill('correct horse battery')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Ada')

  await page.goto('/videos')
  await page.getByText('Main', { exact: true }).first().click()
  await page.locator('input[type=file]').first().setInputFiles(clip)
  await expect(page.getByText('Ready', { exact: true }).filter({ visible: true }).first()).toBeVisible({ timeout: 180_000 })

  const { data } = await (await page.request.get('/v1/assets')).json()
  await page.goto(data[0].embed_url.replace(/^https?:\/\/[^/]+/, ''))
  // The player attaches its stream after the page loads; play only once the first frames are in.
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, null, { timeout: 30_000 })
  const playing = await page.locator('video').evaluate(async (v: HTMLVideoElement) => {
    v.muted = true
    await v.play()
    await new Promise((r) => setTimeout(r, 2500))
    return { time: v.currentTime, width: v.videoWidth, error: v.error?.code ?? null }
  })
  expect(playing.error).toBeNull()
  expect(playing.width).toBeGreaterThan(0)
  expect(playing.time).toBeGreaterThan(1)
  expect(errors).toEqual([])
})
