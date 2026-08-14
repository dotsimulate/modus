export {
  parseMessageText,
  userAuthoredMessageText,
  wrapSkillContext,
  type MessageTextPart,
} from "../../message-context";

export function maskMoveApiTokens(content: string): string {
  return content.replace(/\bmapi-[A-Za-z0-9._-]+-[A-Za-z0-9]{6,}\b/g, (token) => {
    return `${token.slice(0, 5)}…${token.slice(-4)}`;
  });
}
