/**
 * About / Help — the single source of truth behind every surface that tells the
 * user what this build is and where to get help.
 *
 * Three surfaces render this: the `about` dashboard widget, the docs page, and
 * user settings. They must not drift, so none of them may hardcode a version, a
 * link, or a help topic. Add content here and every surface picks it up.
 *
 * Help topics point at ids in the shipped documentation set rather than
 * restating it. The docs corpus is a build-time snapshot staged next to this
 * module, so a topic that names a doc id stays version-matched to the build the
 * user is actually running.
 */

export type AboutLink = {
  label: string;
  href: string;
  description: string;
};

export type HelpTopic = {
  title: string;
  body: string;
  /** Id in the shipped docs set, resolvable through GET /api/docs/<id>. */
  docId?: string;
};

export type AboutInfo = {
  name: string;
  version: string;
  /**
   * Where the version came from. "desktop" is authoritative; "unknown" means the
   * harness is running outside the packaged shell (browser-only `modus start`),
   * where no build stamps it.
   */
  versionSource: "desktop" | "unknown";
  license: string;
  links: AboutLink[];
  topics: HelpTopic[];
};

export const MODUS_REPOSITORY_URL = "https://github.com/dotsimulate/modus";
export const MODUS_LICENSE = "FSL-1.1-ALv2";

/**
 * The desktop shell stamps MODUS_DESKTOP_VERSION from CARGO_PKG_VERSION when it
 * spawns the managed backend. Nothing stamps a browser-only run, and inventing a
 * number there would be worse than admitting the gap: a wrong version sends a bug
 * report to the wrong build.
 */
export function resolveVersion(
  env: Record<string, string | undefined> = process.env,
): { version: string; source: AboutInfo["versionSource"] } {
  const stamped = env.MODUS_DESKTOP_VERSION?.trim();
  if (stamped) return { version: stamped, source: "desktop" };
  return { version: "development", source: "unknown" };
}

const LINKS: AboutLink[] = [
  {
    label: "Documentation",
    href: "#docs",
    description: "The full documentation set, bundled with this build and searchable offline.",
  },
  {
    label: "Source repository",
    href: MODUS_REPOSITORY_URL,
    description: "Issues, releases, and the source for this build.",
  },
  {
    label: "License",
    href: `${MODUS_REPOSITORY_URL}/blob/main/LICENSE`,
    description: `Modus is released under ${MODUS_LICENSE}.`,
  },
];

const TOPICS: HelpTopic[] = [
  {
    title: "What Modus is",
    body:
      "A local-first harness for running AI agents on your own machine. It manages sessions, "
      + "composes prompts, and gives agents controlled access to your projects. Modus has no "
      + "hosted collection service; providers and integrations you configure can receive content.",
    docId: "architecture",
  },
  {
    title: "The five primitives",
    body:
      "Moves, actions, pages, profiles, and missions compose into everything else. Learning what "
      + "each one is for is the fastest way to stop fighting the system.",
    docId: "primitives",
  },
  {
    title: "Configuring an agent",
    body:
      "Agent profiles set the provider, model, tools, prompt, and permissions. Project settings "
      + "layer over your user defaults rather than replacing them.",
    docId: "profile-system",
  },
  {
    title: "Data and network access",
    body:
      "See when configured services can receive content, where Modus stores data, and how to "
      + "remove it deliberately after stopping the app.",
    docId: "data-and-network",
  },
  {
    title: "Running something on demand",
    body:
      "Moves are the invocation primitive: they define what you want, gather context, and can "
      + "expose a widget or an API an agent calls back into.",
    docId: "moves",
  },
  {
    title: "Running something automatically",
    body: "Actions define when an agent runs — on a schedule, on a session event, or via a webhook.",
    docId: "actions",
  },
  {
    title: "What agents are allowed to do",
    body:
      "Modus deliberately gives you and your configured agents broad local-machine capability. "
      + "Moves, plugins, MCP servers, and client extensions execute trusted local code. That is a "
      + "product decision, not a sandbox — treat content from unknown sources as untrusted.",
    docId: "capability-surface",
  },
];

export function getAboutInfo(env?: Record<string, string | undefined>): AboutInfo {
  const { version, source } = resolveVersion(env);
  return {
    name: "Modus",
    version,
    versionSource: source,
    license: MODUS_LICENSE,
    links: LINKS,
    topics: TOPICS,
  };
}
