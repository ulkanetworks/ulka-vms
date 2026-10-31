import { describe, expect, it } from 'vitest'
import { validCDNURL, validHostname, validIP } from '@/lib/schemas'

describe('validHostname', () => {
  it.each(['example.com', 'www.the-shop.co.uk', 'a1.b2.c3'])('accepts %s', (h) => expect(validHostname(h)).toBe(true))
  it.each(['localhost', '-bad.com', 'bad-.com', 'a..b', 'x'.repeat(254) + '.com', ''])('refuses %j', (h) => expect(validHostname(h)).toBe(false))
})

describe('validIP', () => {
  it.each(['1.2.3.4', '255.255.255.255', '::1', '2001:db8::8a2e:370:7334'])('accepts %s', (s) => expect(validIP(s)).toBe(true))
  it.each(['256.0.0.1', '1.2.3', 'abc', '1.2.3.4.5', ''])('refuses %j', (s) => expect(validIP(s)).toBe(false))
})

describe('validCDNURL (a customer\'s own CDN for delivery)', () => {
  it.each(['https://cdn.example.com', 'https://cdn.example.com/', ' https://cdn.example.com '])('accepts %s', (s) => expect(validCDNURL(s)).toBe(true))
  it.each(['http://cdn.example.com', 'https://cdn.example.com:8443', 'https://cdn.example.com/videos', 'https://cdn.example.com/?x', 'cdn.example.com'])('refuses %s', (s) => expect(validCDNURL(s)).toBe(false))
})
