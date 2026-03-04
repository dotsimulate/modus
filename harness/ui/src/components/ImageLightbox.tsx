import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";

type Props = {
  src: string;
  alt: string;
  onClose: () => void;
};

export function ImageLightbox({ src, alt, onClose }: Props) {
  const [zoomed, setZoomed] = useState(false);
  const [origin, setOrigin] = useState("50% 50%");
  const imgRef = useRef<HTMLImageElement>(null);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onKey]);

  const handleImageClick = (e: React.MouseEvent<HTMLImageElement>) => {
    e.stopPropagation();
    if (zoomed) {
      setZoomed(false);
    } else {
      const rect = imgRef.current!.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      setOrigin(`${x}% ${y}%`);
      setZoomed(true);
    }
  };

  return createPortal(
    <div className="lightbox-overlay" onClick={onClose}>
      <img
        ref={imgRef}
        className={`lightbox-image${zoomed ? " lightbox-image--zoomed" : ""}`}
        src={src}
        alt={alt}
        style={{ transformOrigin: origin }}
        onClick={handleImageClick}
      />
    </div>,
    document.body,
  );
}
