import { createContext, useContext } from "react";

type WidgetChrome = {
  setHeaderSuffix: (suffix: string | null) => void;
};

export const WidgetChromeContext = createContext<WidgetChrome>({
  setHeaderSuffix: () => {},
});

export function useWidgetChrome(): WidgetChrome {
  return useContext(WidgetChromeContext);
}
