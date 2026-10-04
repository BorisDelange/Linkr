const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i

export function isImageFileName(name: string): boolean {
  return IMAGE_FILE_RE.test(name)
}
