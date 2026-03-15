import { createContext, useContext, useState, type ReactNode } from "react";

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

  return (
    <FileViewerContext.Provider value={{ path, openFile: setPath, closeFile: () => setPath(null) }}>
      {children}
    </FileViewerContext.Provider>
  );
}
