import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { onUiEvent } from "../sessionStore";

type FileViewerContextValue = {
  path: string | null;
  openFile: (path: string) => void;
  closeFile: () => void;
};

const FileViewerContext = createContext<FileViewerContextValue>({
  path: null,
  openFile: () => {},
  closeFile: () => {},
});

export function useFileViewer() {
  return useContext(FileViewerContext);
}

export function FileViewerProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState<string | null>(null);

  // Listen for backend "open-file" UI events
  useEffect(() => {
    return onUiEvent("open-file", (_sessionId, event) => {
      if (typeof event.path === "string") {
        setPath(event.path);
      }
    });
  }, []);

  return (
    <FileViewerContext.Provider value={{ path, openFile: setPath, closeFile: () => setPath(null) }}>
      {children}
    </FileViewerContext.Provider>
  );
}
