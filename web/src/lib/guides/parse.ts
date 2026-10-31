import { rules } from '@/lib/rules'

export type Block = { kind: 'h' | 'h3' | 'p' | 'note' | 'code'; text: string } | { kind: 'ul'; items: string[] } | { kind: 'ol'; items: string[] } | { kind: 'img'; alt: string; src: string }

export function parse(src: string, origin: string): Block[] {
  const out: Block[] = []
  src
    .replaceAll('{origin}', origin)
    .replaceAll('{player}', rules.player_url)
    .split(/\n?```\n?/)
    .forEach((part, i) => {
      if (i % 2) return void out.push({ kind: 'code', text: part })
      // A heading is its own line, even with text right under it; a list starts its own block, even right under a sentence.
      for (const para of part.split(/\n\n+|(?<=^###? [^\n]*)\n|(?<=^(?!- |\d+\. )[^\n]*)\n(?=- |1\. )/m).map((s) => s.trim()).filter(Boolean)) {
        const img = para.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/)
        if (para.startsWith('### ')) out.push({ kind: 'h3', text: para.slice(4) })
        else if (para.startsWith('## ')) out.push({ kind: 'h', text: para.slice(3) })
        else if (para.startsWith('> ')) out.push({ kind: 'note', text: para.slice(2) })
        else if (para.startsWith('- ')) out.push({ kind: 'ul', items: para.split(/\n- /).map((s) => s.replace(/^- /, '')) })
        else if (/^1\. /.test(para)) out.push({ kind: 'ol', items: para.split(/\n\d+\. /).map((s) => s.replace(/^1\. /, '')) })
        else if (img) out.push({ kind: 'img', alt: img[1], src: img[2] })
        else out.push({ kind: 'p', text: para })
      }
    })
  return out
}
