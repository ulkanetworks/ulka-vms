import { describe, expect, it } from 'vitest'
import { parse } from './parse'

describe('parse', () => {
  it('starts a list right under a sentence', () => {
    expect(parse('Keys can have:\n- an expiry\n- an IP list\n\nSteps:\n1. Make\n2. Sign', '')).toEqual([
      { kind: 'p', text: 'Keys can have:' },
      { kind: 'ul', items: ['an expiry', 'an IP list'] },
      { kind: 'p', text: 'Steps:' },
      { kind: 'ol', items: ['Make', 'Sign'] },
    ])
  })
})
