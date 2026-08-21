import { Markdown } from "./Markdown";
import { MoveContextDisclosure } from "./MoveContextDisclosure";
import { parseMessageText, userAuthoredMessageText, type MessageTextPart } from "../move-context";
import { parsePastedContent } from "../pasted-content";
import type { Message } from "../../../sdk/index";
import { PasteBlock } from "./PasteBlock";

/**
 * One block of message text, with anything the harness injected into it folded
 * away behind a disclosure.
 *
 * A move- or skill-launched prompt carries a preamble the user never typed, and
 * showing it verbatim buries the actual request — so a user message is split
 * into the text a person authored and the contexts that were attached to it.
 * Assistant text is never split; nothing is injected into it.
 *
 * Shared rather than owned by the transcript: every surface that shows a prompt
 * has to make the same separation, and a second copy of this rule is how one of
 * them ends up rendering `<!-- move:x -->` at a reader.
 */
export function MessageText({
  messageId,
  role,
  text,
  isNew = false,
  revealText = false,
  onContextMenu,
}: {
  messageId: string;
  role: Message["role"];
  text: string;
  isNew?: boolean;
  revealText?: boolean;
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  const parts = role === "user" ? parseMessageText(text) : [];
  const injectedContexts = parts.filter(
    (part): part is Exclude<MessageTextPart, { type: "text" }> => part.type !== "text",
  );
  const visibleText = injectedContexts.length ? userAuthoredMessageText(text) : text;
  const visibleParts = role === "user" ? parsePastedContent(visibleText) : [];

  return (
    <>
      {visibleText && (
        <div
          className={`message-content${isNew ? " message-content--new" : ""}`}
          onContextMenu={onContextMenu}
        >
          {visibleParts.length > 0
            ? visibleParts.map((part, index) => part.type === "paste"
                ? <PasteBlock key={`paste:${index}`} text={part.text} />
                : <Markdown key={`text:${index}`} content={part.text} revealText={revealText} />)
            : <Markdown content={visibleText} revealText={revealText} />}
        </div>
      )}
      {injectedContexts.length > 0 && (
        <div className="move-context-list">
          {injectedContexts.map((context, index) => {
            const isSkill = context.type === "skill_context";
            const name = isSkill ? context.skillName : context.moveName;
            return (
              <MoveContextDisclosure
                key={`${messageId}:${context.type}:${name}:${index}`}
                moveName={name}
                content={context.content}
                kind={isSkill ? "skill" : "move"}
              />
            );
          })}
        </div>
      )}
    </>
  );
}
