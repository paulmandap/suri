import { describe, expect, it } from 'vitest'
import { vscodeFolderUrl } from '../src/main/vscode-url'

describe('vscodeFolderUrl', () => {
  it('builds a vscode:// URL for a Windows folder', () => {
    expect(vscodeFolderUrl('C:\\work\\demo-project')).toBe('vscode://file/C:/work/demo-project')
    expect(vscodeFolderUrl('C:\\work\\')).toBe('vscode://file/C:/work')
  })

  it('encodes characters that would break the URL', () => {
    expect(vscodeFolderUrl('C:\\my repo\\#1 & more')).toBe(
      'vscode://file/C:/my%20repo/%231%20%26%20more'
    )
  })

  it('handles POSIX paths', () => {
    expect(vscodeFolderUrl('/home/a b/proj')).toBe('vscode://file/home/a%20b/proj')
  })
})
