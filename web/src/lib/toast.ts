import { toastManager } from '@/components/ui/toast'

// Short messages about what just happened. Errors stay until closed.
// The same words again (several settings saved in a row) refresh the toast on screen rather than piling up copies.
const shown = new Map<string, string>()
export function toast(text: string, tone: 'success' | 'danger' | 'info' = 'success') {
  const type = tone === 'danger' ? 'error' : tone
  const was = shown.get(text)
  if (was) toastManager.close(was)
  const id: string = toastManager.add({ title: text, type, timeout: tone === 'danger' ? 0 : 5000, onRemove: (): void => void (shown.get(text) === id && shown.delete(text)) })
  shown.set(text, id)
}
