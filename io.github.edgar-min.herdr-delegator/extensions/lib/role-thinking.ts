// Role-bound thinking observation for the Herdr delegator extension.
//
// OMP's extension API cannot answer this. `ctx.models.resolve()` documents that
// "Thinking/routing suffixes are accepted and resolved to the base model (pass
// effort separately)", so a role configured as `provider/model:medium` and one
// configured as `provider/model` are indistinguishable through the facade, and
// nothing else on `ExtensionAPI`/`ExtensionContext` reports a role's level. The
// coding-agent core that owns the selector grammar does expose it, so the
// extension asks core directly and republishes the answer as a bridge fact.
//
// The core import is dynamic on purpose. This module is reachable from the MCP
// server process (mcp/tools.ts -> bridge.ts -> here), which runs outside OMP and
// carries no coding-agent dependency; a static import would drag core into that
// process at load time. An unresolvable module or an uninitialized settings
// singleton therefore degrades to "no role-bound level observed", which is
// exactly the behaviour that existed before this observation did.
import { isThinkingLevel } from "./config";
import type { ThinkingLevel } from "./contracts";

type RoleThinkingSelector = (role: string) => unknown;

let selectorLoad: Promise<RoleThinkingSelector | undefined> | undefined;

async function loadRoleThinkingSelector(): Promise<RoleThinkingSelector | undefined> {
  try {
    const [resolver, settingsModule] = await Promise.all([
      import("@oh-my-pi/pi-coding-agent/config/model-resolver"),
      import("@oh-my-pi/pi-coding-agent/config/settings"),
    ]);
    // `settings` is a proxy over the live singleton, so the closure keeps
    // reading current configuration rather than a startup snapshot.
    const { settings } = settingsModule;
    return (role) => resolver.extractExplicitThinkingSelector(role, settings);
  } catch {
    return undefined;
  }
}

/**
 * The thinking level an OMP role alias is bound to, or `undefined` when the role
 * binds none — including every case where core cannot be consulted at all.
 *
 * Core reports a level only for an explicit `:level` suffix reachable from the
 * role's own configured pattern, so an unconfigured role stays unbound instead
 * of inheriting a level from the default chain.
 */
export async function observeRoleThinking(role: string): Promise<ThinkingLevel | undefined> {
  selectorLoad ??= loadRoleThinkingSelector();
  const selector = await selectorLoad;
  if (!selector) return undefined;
  let level: unknown;
  try {
    level = selector(role);
  } catch {
    return undefined;
  }
  // Core's `ConfiguredThinkingLevel` is a superset: `inherit` is a level there
  // and a non-level here, and it must not survive as an effective launch level.
  return isThinkingLevel(level) ? level : undefined;
}
