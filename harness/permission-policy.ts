export type PermissionPolicy =
  | "bypass"
  | "auto-edit"
  | "ask"
  | {
      default: "approve" | "ask";
      autoApprove?: string[];
      requireApproval?: string[];
    };

type LegacyPermissionPolicy = {
  default: "approve" | "ask" | "allow";
  autoApprove?: string[];
  requireApproval?: string[];
};

/** Normalize the one legacy spelling that shipped in hand-authored profiles. */
export function normalizePermissionPolicy(
  policy: PermissionPolicy | LegacyPermissionPolicy | undefined,
): { policy: PermissionPolicy | undefined; normalizedLegacyAllow: boolean } {
  if (!policy || typeof policy === "string" || policy.default !== "allow") {
    return { policy: policy as PermissionPolicy | undefined, normalizedLegacyAllow: false };
  }
  return {
    policy: { ...policy, default: "approve" },
    normalizedLegacyAllow: true,
  };
}

export function permissionPolicyNeedsApproval(
  policy: PermissionPolicy | undefined,
  toolName: string,
  shellTools: ReadonlySet<string>,
): boolean {
  const resolved = policy ?? "bypass";
  if (resolved === "bypass") return false;
  if (resolved === "ask") return true;
  if (resolved === "auto-edit") return shellTools.has(toolName.toLowerCase());
  const lower = toolName.toLowerCase();
  if (resolved.requireApproval?.some((name) => name.toLowerCase() === lower)) return true;
  if (resolved.autoApprove?.some((name) => name.toLowerCase() === lower)) return false;
  return resolved.default === "ask";
}

export function pendingPermissionCount(
  currentCount: number,
  event: "permission_request" | "permission_resolved",
  requestAlreadyPending: boolean,
): number {
  if (event === "permission_request") return currentCount + (requestAlreadyPending ? 0 : 1);
  return Math.max(0, currentCount - (requestAlreadyPending ? 1 : 0));
}
