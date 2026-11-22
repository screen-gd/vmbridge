import type { ProjectRow } from "../store.ts";

/**
 * T3 clients see one machine. Each project lives at `/projects/<id>/<name>`, and any other VM
 * path under `/workspace` (worktrees, T3 data) at `/vms/<vmId>/workspace/...`.
 * Only fields that hold paths are rewritten; IDs pass through unchanged.
 */

const pathKeys = new Set(["cwd", "path", "paths", "directory", "root", "baseDir"]);
export const isPathKey = (key: string) =>
  pathKeys.has(key) || /(?:Path|Paths|Root|Roots|Directory|Directories|Dir)$/.test(key);

export const repoName = (url: string) =>
  URL.parse(url)?.pathname.split("/").filter(Boolean).pop()?.replace(/\.git$/, "") || "repository";

export const projectRoot = (project: Pick<ProjectRow, "id" | "url">) => `/projects/${project.id}/${repoName(project.url)}`;

const vmRoot = (vmId: string) => `/vms/${vmId}`;

const within = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

export type Direction = "in" | "out";

/** The environment ID T3 on the VM has, and the one clients know VM Bridge by. */
export interface Environments {
  vm: string;
  client: string;
}

/**
 * Rewrites paths for one VM: `out` from VM to client, `in` from client to VM. Thread links in any text, such as
 * the one an agent writes for a child thread it delegated, name an environment, so they get the other side's.
 */
export function translate(value: unknown, vmId: string, direction: Direction, projects: readonly ProjectRow[], environments?: Environments): unknown {
  // A project on several VMs has the same client root on each, mapped to that VM's own checkout.
  const checkouts = projects.flatMap((project) =>
    project.vms.flatMap((entry) => (entry.vmId === vmId && entry.checkoutPath ? [{ vm: entry.checkoutPath, client: projectRoot(project) }] : [])),
  );

  const [from, to] = direction === "out" ? [environments?.vm, environments?.client] : [environments?.client, environments?.vm];
  // T3's `t3-thread://v2/<environment>/<thread>` links, and the hosted `/threads/<environment>/<thread>` form.
  const link = (item: string) =>
    from && to && item.includes(from)
      ? item.replaceAll(`t3-thread://v2/${from}/`, `t3-thread://v2/${to}/`).replaceAll(`/threads/${from}/`, `/threads/${to}/`)
      : item;

  const path = (item: string) => {
    for (const checkout of checkouts) {
      const [from, to] = direction === "out" ? [checkout.vm, checkout.client] : [checkout.client, checkout.vm];
      if (within(item, from)) return to + item.slice(from.length);
    }
    if (direction === "out" && within(item, "/workspace")) return vmRoot(vmId) + item;
    if (direction === "in" && within(item, vmRoot(vmId))) return item.slice(vmRoot(vmId).length) || "/";
    return item;
  };

  const visit = (item: unknown, key: string): unknown => {
    if (typeof item === "string") return isPathKey(key) ? path(item) : link(item);
    if (Array.isArray(item)) return item.map((entry) => visit(entry, key));
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, visit(entry, name)]));
    }
    return item;
  };
  return visit(value, "");
}

/** The project a client path points into, if any. */
export function projectForPath(path: string, projects: readonly ProjectRow[]) {
  return projects.find((project) => within(path, `/projects/${project.id}`));
}

/** The VM a `/vms/<id>/...` client path points into, if any. */
export function vmForPath(path: string) {
  return /^\/vms\/([^/]+)(?:\/|$)/.exec(path)?.[1];
}
