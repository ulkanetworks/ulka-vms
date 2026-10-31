import { api } from '@/lib/api'
import { message } from '@/lib/messages'
import { refresh } from '@/lib/query'
import { toast } from '@/lib/toast'

/** Processes a failed video again from its kept original; true when it was accepted. */
export async function retryVideo(id: string): Promise<boolean> {
  try {
    await api('POST', `/v1/assets/${id}/retry`)
    toast('Processing it again. This takes a few minutes.')
    await refresh('/v1/assets', '/v1/libraries')
    return true
  } catch (err) {
    toast(message(err), 'danger')
    return false
  }
}
