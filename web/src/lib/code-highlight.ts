import { createHighlighter } from '@tanstack/highlight/core'
import { html } from '@tanstack/highlight/languages/html'
import { js } from '@tanstack/highlight/languages/js'
import { json } from '@tanstack/highlight/languages/json'
import { shell } from '@tanstack/highlight/languages/shell'
import { ts } from '@tanstack/highlight/languages/ts'
import { createThemeCss } from '@tanstack/highlight/theme'
import { githubDarkTheme } from '@tanstack/highlight/themes/github-dark'
import { githubLightTheme } from '@tanstack/highlight/themes/github-light'

const highlighter = createHighlighter({ languages: [shell, json, js, ts, html] })

// Token colours only: the library's own `pre.th-code` box rule is dropped so Code keeps the console's frame.
const style = document.createElement('style')
style.textContent = createThemeCss({ light: githubLightTheme, dark: githubDarkTheme, darkSelector: '.dark' }).replace(/pre\.th-code \{[^}]*\}/, '')
document.head.append(style)

export const guessLang = (code: string) =>
  /^(curl|\$|#!|npm)/.test(code) ? 'shell' : /^[{[]/.test(code) ? 'json' : code.startsWith('<') ? 'html' : 'ts'

// Escaped HTML from the library; unknown languages come back as plain escaped text.
export const highlight = (code: string, lang = guessLang(code)) => highlighter.highlight(code, { lang }).html
