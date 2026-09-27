/** A failed media preview must not send binary bytes through the text reader. */
export function isPreviewMediaPath(path: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|bmp|ico|avif|tiff?|svg|wav|mp3|ogg|m4a|aac|flac|mp4|webm|mov|mkv|avi|pdf)$/i.test(path);
}
