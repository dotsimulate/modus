import { TerminalView } from "../components/lazy-views";
import { useProfiles } from "../providers/ProfileContext";
import type { WidgetBase, WidgetProps } from "./types";

type PersistentTerminalConfig = WidgetBase & {
  type: "persistent-terminal";
  ownerType?: string;
  ownerName?: string;
};

export default function PersistentTerminalWidget({ config, widgetId, active = true }: WidgetProps<PersistentTerminalConfig>) {
  const { activeCwd } = useProfiles();
  return (
    <TerminalView
      cwd={activeCwd}
      visible={active}
      ownerType={config.ownerType ?? "page"}
      ownerName={config.ownerName ?? widgetId}
    />
  );
}
