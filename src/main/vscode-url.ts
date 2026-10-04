/**
 * `vscode://file/C:/path/to/folder` for a folder path. Each segment is
 * URL-encoded (a `#` or space in a folder name must not break the URL); the
 * drive colon stays as it is.
 */
export function vscodeFolderUrl(folder: string): string {
  const segments = folder
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment, i) => segment !== '' || i === 0)
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'))
  const path = segments.join('/')
  return `vscode://file${path.startsWith('/') ? '' : '/'}${path}`
}
