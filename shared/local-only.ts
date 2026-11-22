/**
 * local-only.ts — the two checks that keep every request on this machine.
 *
 * The lab's promise is that no question, chunk or embedding leaves the
 * machine (PLAN §1). Two settings could quietly break that promise while
 * everything kept working: an Ollama URL pointing at another host, or a
 * model name that Ollama serves from its cloud. This file holds the rule
 * for each, in one place, so the embedder, the chat client and check-env
 * can't each grow a slightly different version.
 *
 * It's in shared/ because it has no Node dependencies, not because the
 * browser needs it. The browser never talks to Ollama.
 */

/** Hostnames that mean "this machine". */
export const LOCAL_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Whether a URL is parseable and points at this machine. */
export function isLocalUrl(raw: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(raw).hostname);
  } catch (error: unknown) {
    // new URL throws TypeError for anything unparseable; anything else is a bug.
    if (error instanceof TypeError) return false;
    throw error;
  }
}

/**
 * Whether a model runs on ollama.com rather than this machine: a name
 * ending in ":cloud" or "-cloud", or a /api/tags entry with a remote_*
 * field set. The same rule the other local labs enforce.
 */
export function isRemoteModel(name: string, entry?: Record<string, unknown>): boolean {
  if (/[:-]cloud$/i.test(name)) return true;
  return entry !== undefined && Object.keys(entry).some((k) => k.startsWith("remote_") && entry[k]);
}
