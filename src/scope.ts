/**
 * Project scope resolution shared by the tools and the GUI RPC.
 *
 * Sessions inside a real project's directory can carry the root project id
 * `global`; the memory plugin always operates on the project the session
 * physically belongs to, so both paths must resolve it the same way.
 */

import type { PluginContext } from "../context.js";
import { getSessionInfo } from "../history.js";
import { listProjects, projectForDirectory, resolveProjectID } from "../projects.js";
import type { SessionInfoLike } from "../types.js";

export interface CurrentProject {
  info: SessionInfoLike;
  projectID: string;
  directory?: string;
}

/** The project a session belongs to for the memory plugin. */
export async function currentProject(ctx: PluginContext, sessionID: string): Promise<CurrentProject> {
  const info = await getSessionInfo(ctx, sessionID);
  // Sessions inside a real project's directory can carry the root project
  // id "global"; resolve them to the project their directory belongs to.
  const projectID = (await resolveProjectID(info)) || info.projectID;
  return { info, projectID, directory: info.location?.directory };
}

export interface ScopeInput {
  /** Routed session whose project should be used when no explicit id is given. */
  sessionID?: string | undefined;
  /** Explicit project id, when the caller already resolved one. */
  projectID?: string | undefined;
}

export interface ResolvedScope {
  projectID?: string | undefined;
  directory?: string | undefined;
}

/**
 * Resolve the project for a request: an explicit id wins, then the routed
 * session, then the server location (with the directory fallback).
 */
export async function resolveScopeProjectID(ctx: PluginContext, input: ScopeInput = {}): Promise<ResolvedScope> {
  const explicit = input.projectID?.trim();
  if (explicit && explicit !== "global") return { projectID: explicit };

  if (input.sessionID) {
    const current = await currentProject(ctx, input.sessionID).catch(() => undefined);
    if (current) return { projectID: current.projectID, directory: current.directory };
  }

  const own = String(ctx.location.project.id);
  const directory = ctx.location.directory;
  if (own && own !== "global") return { projectID: own, directory };

  const projects = await listProjects().catch(() => []);
  const resolved = projectForDirectory(directory, projects)?.id;
  return { projectID: resolved || own, directory };
}
