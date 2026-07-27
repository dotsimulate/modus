import { CompactDisclosure } from "./CompactDisclosure";
import { Markdown } from "./Markdown";
import { maskMoveApiTokens } from "../move-context";

type Props = {
  moveName: string;
  content: string;
  /** Skills fold identically to moves; only the label differs. */
  kind?: "move" | "skill";
};

export function MoveContextDisclosure({ moveName, content, kind = "move" }: Props) {
  return (
    <CompactDisclosure label={kind} summary={moveName} className="move-context-disclosure">
      <Markdown content={maskMoveApiTokens(content)} />
    </CompactDisclosure>
  );
}
