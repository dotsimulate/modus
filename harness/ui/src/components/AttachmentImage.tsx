import { useEffect, useState } from "react";

/**
 * Shared renderer for base64 image payloads.
 *
 * Lives outside MessageBubble because tool results carry images too: a tool
 * that returns a screenshot or a generated image used to be JSON.stringify'd
 * into the result text, so the user saw a truncated wall of base64 instead of
 * the picture. Both surfaces render through this.
 */

/**
 * Decode base64 to a blob URL rather than a `data:` URI. A multi-megabyte
 * data URI sits in the DOM as a string for the lifetime of the node; a blob
 * URL is a handle that can be revoked when the component unmounts.
 */
export function base64ToBlobUrl(data: string, mediaType: string): string {
  const binary = atob(data);
  const chunkSize = 8192;
  const chunks: ArrayBuffer[] = [];
  for (let offset = 0; offset < binary.length; offset += chunkSize) {
    const slice = binary.slice(offset, offset + chunkSize);
    const bytes = new Uint8Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      bytes[i] = slice.charCodeAt(i);
    }
    chunks.push(bytes.buffer);
  }
  return URL.createObjectURL(new Blob(chunks, { type: mediaType }));
}

export function AttachmentImage({
  mediaType,
  data,
  alt,
  onOpen,
}: {
  mediaType: string;
  data: string;
  alt: string;
  onOpen: (src: string, alt: string) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let url: string | null = null;
    try {
      url = base64ToBlobUrl(data, mediaType);
      setSrc(url);
    } catch {
      setSrc(null);
    }
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [data, mediaType]);

  if (!src) {
    return <div className="message-image message-image--unavailable">{alt}</div>;
  }

  return (
    <img
      className="message-image"
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onClick={() => onOpen(src, alt)}
    />
  );
}
