import { api } from '@/lib/api'
import { message } from '@/lib/messages'
import { refresh } from '@/lib/query'
import { toast } from '@/lib/toast'

// Saves a change and tells the person; the form keeps what they typed on failure.
export async function save<T>(path: string, method: 'PATCH' | 'PUT', body: unknown, done = 'Saved.'): Promise<T | null> {
  try {
    const out = await api<T>(method, path, body)
    await refresh('/v1/libraries')
    toast(done)
    return out
  } catch (err) {
    toast(message(err), 'danger')
    return null
  }
}
