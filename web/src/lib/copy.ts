import { toast } from '@/lib/toast'

// Copies text; a refused clipboard says so, and the text stays on screen to select by hand.
export async function copy(value: string, what: string) {
  try {
    await navigator.clipboard.writeText(value)
    toast(`${what} copied.`)
    return true
  } catch {
    toast("Couldn't copy. Select the text and copy it by hand.", 'danger')
    return false
  }
}
