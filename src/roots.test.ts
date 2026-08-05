import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AccessDeniedError,
  assertAllowedPath,
  authorizeWorkspacePath,
  authorizeWorkspaceTarget,
  canonicalTarget,
  expandHomePath,
  normalizeRootPolicies,
  resolveAllowedPath,
} from "./roots.js";

const home = homedir();
assert.equal(expandHomePath("~"), home);
assert.equal(expandHomePath("~/personal/devspace"), resolve(home, "personal", "devspace"));
assert.equal(expandHomePath("~user/project"), "~user/project");
assert.equal(expandHomePath("$HOME/project"), "$HOME/project");
assert.equal(assertAllowedPath("~/personal/devspace", [join(home, "personal")]), resolve(home, "personal", "devspace"));
assert.equal(assertAllowedPath("~/personal/devspace", ["~/personal"]), resolve(home, "personal", "devspace"));
assert.equal(resolveAllowedPath("~/file.txt", "/workspace", ["/workspace"]), resolve("/workspace", "~/file.txt"));

const root = await mkdtemp(join(tmpdir(), "devspace-roots-test-"));
try {
  const projects = join(root, "pool", "projects");
  const alias = join(root, "home", "projects");
  const externalReadOnly = join(root, "external-read-only");
  const undeclared = join(root, "undeclared");
  await mkdir(projects, { recursive: true });
  await mkdir(join(root, "home"), { recursive: true });
  await mkdir(externalReadOnly);
  await mkdir(undeclared);
  await symlink(projects, alias, "dir");
  await writeFile(join(projects, "README.md"), "hello\n");
  await writeFile(join(externalReadOnly, "config.txt"), "readonly\n");
  await writeFile(join(undeclared, "secret.txt"), "nope\n");

  const policies = normalizeRootPolicies([
    { path: projects, aliases: [alias], access: "read-write" },
    { path: externalReadOnly, access: "read-only" },
  ]);
  const opened = authorizeWorkspacePath(join(alias, "README.md"), policies, "read");
  assert.equal(opened.logicalPath, join(alias, "README.md"));
  assert.equal(opened.canonicalPath, join(projects, "README.md"));
  assert.equal(opened.policy.access, "read-write");

  const project = join(projects, "project");
  await mkdir(project);
  await symlink(externalReadOnly, join(project, "linked-config"), "dir");
  await symlink(undeclared, join(project, "escape"), "dir");

  const crossRootRead = authorizeWorkspaceTarget("linked-config/config.txt", project, policies, "read");
  assert.equal(crossRootRead.canonicalPath, join(externalReadOnly, "config.txt"));
  assert.throws(
    () => authorizeWorkspaceTarget("linked-config/config.txt", project, policies, "write"),
    AccessDeniedError,
  );
  assert.throws(
    () => authorizeWorkspaceTarget("escape/secret.txt", project, policies, "read"),
    AccessDeniedError,
  );

  const future = authorizeWorkspaceTarget("new-file.txt", project, policies, "write");
  assert.equal(future.canonicalPath, join(project, "new-file.txt"));
  assert.equal(canonicalTarget(join(alias, "project", "new-file.txt")), join(project, "new-file.txt"));

  const wrongAlias = join(root, "wrong-alias");
  await symlink(externalReadOnly, wrongAlias, "dir");
  assert.throws(
    () => normalizeRootPolicies([{ path: projects, aliases: [wrongAlias], access: "read-write" }]),
    /resolves to/,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
