import { createContext, useContext } from "react";

export type PinGroup = {
  id: string;
  name: string;
  paths: string[];
};

type PinboardContextValue = {
  groups: PinGroup[];
  activeGroupId: string | null;
  activeGroup: PinGroup | null;
  setActiveGroup: (id: string) => void;
  addGroup: (name: string) => string;
  removeGroup: (id: string) => void;
  renameGroup: (id: string, name: string) => void;
  pinToActive: (path: string) => void;
  pinToGroup: (groupId: string, path: string) => void;
  unpinFromActive: (path: string) => void;
  isFilePinned: (path: string) => boolean;
};

export const PinboardContext = createContext<PinboardContextValue>({
  groups: [],
  activeGroupId: null,
  activeGroup: null,
  setActiveGroup: () => {},
  addGroup: () => "",
  removeGroup: () => {},
  renameGroup: () => {},
  pinToActive: () => {},
  pinToGroup: () => {},
  unpinFromActive: () => {},
  isFilePinned: () => false,
});

export function usePinboard() {
  return useContext(PinboardContext);
}
