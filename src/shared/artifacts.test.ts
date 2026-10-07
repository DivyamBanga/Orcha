import { describe, expect, it } from 'vitest'
import { artifactsAsCode, splitArtifacts } from './artifacts'

describe('splitArtifacts', () => {
  it('finds artifacts between text, with their attributes', () => {
    const text =
      'Here you go:\n\n<artifact identifier="todo" type="application/vnd.react" title="To-do app">\nexport default () => <p/>\n</artifact>\n\nEnjoy.'
    expect(splitArtifacts(text)).toEqual([
      { kind: 'text', text: 'Here you go:\n\n' },
      {
        kind: 'artifact',
        artifact: {
          identifier: 'todo',
          type: 'application/vnd.react',
          title: 'To-do app',
          language: null,
          content: 'export default () => <p/>',
          complete: true
        }
      },
      { kind: 'text', text: '\n\nEnjoy.' }
    ])
  })

  it('keeps an artifact that is still streaming, marked incomplete', () => {
    const segments = splitArtifacts(
      "Sure.\n<artifact identifier='page' type='text/html' title='Page'>\n<h1>Hel"
    )
    expect(segments[1]).toEqual({
      kind: 'artifact',
      artifact: {
        identifier: 'page',
        type: 'text/html',
        title: 'Page',
        language: null,
        content: '<h1>Hel',
        complete: false
      }
    })
  })

  it('holds back an opening tag that has not finished arriving', () => {
    expect(splitArtifacts('Building it now <artifact identifier="x" ty')).toEqual([
      { kind: 'text', text: 'Building it now ' }
    ])
  })

  it('treats an unknown type as code, and keeps the language', () => {
    const [seg] = splitArtifacts(
      '<artifact identifier="s" type="text/python" language="python" title="Script">print(1)</artifact>'
    )
    expect(seg).toMatchObject({
      artifact: { type: 'application/vnd.code', language: 'python', content: 'print(1)' }
    })
  })
})

describe('artifactsAsCode', () => {
  it('turns artifacts into titled code blocks', () => {
    expect(
      artifactsAsCode(
        'A\n<artifact identifier="p" type="text/html" title="Page">\n<b>hi</b>\n</artifact>'
      )
    ).toBe('A\n\n**Page**\n\n```html\n<b>hi</b>\n```\n')
  })
})
