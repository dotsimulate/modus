import { createContext, useContext, useEffect, useState } from "react";
import { resolveMarkdownImageTarget } from "../markdown-images";
import { ticketedRawFileUrl } from "../rawFileUrl";

export const MarkdownImageContext = createContext<{ sourceFile?: string; cwd?: string | null }>({});

export function MarkdownImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const { sourceFile, cwd } = useContext(MarkdownImageContext);
  const target = resolveMarkdownImageTarget(src ?? "", sourceFile, cwd);
  // Remount only when the resolved source changes, not on streamed text updates.
  return target.kind === "local"
    ? <LocalImage key={target.path} path={target.path} alt={alt} title={title} />
    : <ImagePreview key={src} src={target.kind === "web" ? target.url : ""} alt={alt} title={title} />;
}

function LocalImage({ path, alt, title }: { path: string; alt?: string; title?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void ticketedRawFileUrl(path).then((value) => {
      if (!cancelled) setUrl(value);
    });
    return () => { cancelled = true; };
  }, [path]);
  if (url === null) return <span role="status">Loading image: {alt || "image"}</span>;
  return <ImagePreview src={url} alt={alt} title={title} />;
}

function ImagePreview({ src, alt, title }: { src: string; alt?: string; title?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span role="status">Image unavailable: {alt || "image"}</span>;
  return <img src={src} alt={alt ?? ""} title={title} onError={() => setFailed(true)} />;
}
