import { createContext, useContext, useState, type ReactNode } from "react";
import { ChatFileViewer } from "../components/ChatFileViewer";

type FileViewerContextValue = {
  openFile: (path: string) => void;
};

const FileViewerContext = createContext<FileViewerContextValue>({ openFile: () => {} });

export function useFileViewer() {
  return useContext(FileViewerContext);
}

export function FileViewerProvider({ children }: { children: ReactNode }) {
  const [filePath, setFilePath] = useState<string | null>(null);

  return (
    <FileViewerContext.Provider value={{ openFile: setFilePath }}>
      {children}
      <ChatFileViewer filePath={filePath} onClose={() => setFilePath(null)} />
    </FileViewerContext.Provider>
  );
}
