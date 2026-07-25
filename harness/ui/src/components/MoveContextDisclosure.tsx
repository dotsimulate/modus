import { CompactDisclosure } from "./CompactDisclosure";
import { Markdown } from "./Markdown";
import { maskMoveApiTokens } from "../move-context";

type Props = {
  moveName: string;
  content: string;
};

export function MoveContextDisclosure({ moveName, content }: Props) {
  return (
    <CompactDisclosure label="move" summary={moveName} className="move-context-disclosure">
      <Markdown content={maskMoveApiTokens(content)} />
    </CompactDisclosure>
  );
}
