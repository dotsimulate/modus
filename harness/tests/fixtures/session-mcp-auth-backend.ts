import { existsSync, writeFileSync } from "node:fs";
import {
  bindSessionMcpCredential,
  mintSessionMcpCredential,
  revokeSessionMcpCredentials,
} from "../../session-mcp-credential";

const credentialPath = process.env.MODUS_TEST_MCP_CREDENTIAL_FILE;
const revokePath = process.env.MODUS_TEST_MCP_REVOKE_FILE;
if (!credentialPath || !revokePath) throw new Error("missing session MCP integration fixture paths");

const sessionId = "session-mcp-auth-fixture";
const credential = mintSessionMcpCredential("integration-scope");
if (!credential) throw new Error("legacy MCP bearer mode unexpectedly enabled");
bindSessionMcpCredential(sessionId, credential);
writeFileSync(credentialPath, JSON.stringify({ credential, sessionId }), "utf8");

const poll = setInterval(() => {
  if (!existsSync(revokePath)) return;
  revokeSessionMcpCredentials(sessionId);
  clearInterval(poll);
}, 20);

await import("../../index");
