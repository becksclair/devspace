import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellRuntime, runConfiguredShell } from "./shell-environment.js";

const root = await mkdtemp(join(tmpdir(), "devspace-shell-test-"));
try {
  const bin = join(root, "bin");
  await mkdir(bin);
  const tool = join(bin, "devspace-user-tool");
  await writeFile(tool, "#!/bin/sh\necho user-tool-ok\n");
  await chmod(tool, 0o755);
  await writeFile(join(root, ".bash_profile"), [
    'export PATH="$HOME/bin:$PATH"',
    'export DEVSPACE_OAUTH_OWNER_TOKEN="profile-leak"',
    'export DEVSPACE_ASGARD_NODE_TOKEN="profile-leak-too"',
    '',
  ].join("\n"));

  const baseEnvironment = {
    HOME: root,
    PATH: "/usr/bin:/bin",
    DEVSPACE_OAUTH_OWNER_TOKEN: "must-not-leak",
    DEVSPACE_ASGARD_NODE_TOKEN: "must-not-leak-either",
    DEVELOPMENT_API_TOKEN: "keep-this-user-value",
  };
  const secretNames = ["DEVSPACE_OAUTH_OWNER_TOKEN", "DEVSPACE_ASGARD_NODE_TOKEN"];

  assert.throws(
    () => createShellRuntime({ path: "/bin/bash", mode: "service" }, ["BAD-NAME;echo injected"], baseEnvironment),
    /Invalid DevSpace infrastructure secret name/,
  );
  assert.throws(
    () => createShellRuntime({ path: "/bin/bash", mode: "service", environment: { "BAD-NAME": "x" } }, [], baseEnvironment),
    /Invalid configured shell environment name/,
  );
  assert.throws(
    () => createShellRuntime({ path: "/bin/bash", mode: "service", environment: { VALID_NAME: "bad\0value" } }, [], baseEnvironment),
    /contains NUL/,
  );

  const serviceRuntime = createShellRuntime({ path: "/bin/bash", mode: "service" }, secretNames, baseEnvironment);
  const serviceResult = await runConfiguredShell(serviceRuntime, "command -v devspace-user-tool || true", root);
  assert.equal(serviceResult.stdout.trim(), "");

  const loginRuntime = createShellRuntime({ path: "/bin/bash", mode: "login" }, secretNames, baseEnvironment);
  const loginResult = await runConfiguredShell(
    loginRuntime,
    "printf 'tool=%s\\n' \"$(command -v devspace-user-tool)\"; printf 'oauth=%s\\n' \"${DEVSPACE_OAUTH_OWNER_TOKEN-unset}\"; printf 'node=%s\\n' \"${DEVSPACE_ASGARD_NODE_TOKEN-unset}\"; printf 'dev=%s\\n' \"${DEVELOPMENT_API_TOKEN-unset}\"",
    root,
  );
  assert.match(loginResult.stdout, new RegExp(`tool=${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(loginResult.stdout, /oauth=unset/);
  assert.match(loginResult.stdout, /node=unset/);
  assert.match(loginResult.stdout, /dev=keep-this-user-value/);
  assert.deepEqual(loginRuntime.filteredSecretNames, secretNames.sort());

  await writeFile(join(root, ".bash_profile"), [
    'export PATH="$HOME/bin:$PATH"',
    'readonly DEVSPACE_OAUTH_OWNER_TOKEN="profile-secret"',
    '',
  ].join("\n"));
  await assert.rejects(
    () => runConfiguredShell(loginRuntime, "printf 'oauth=%s\\n' \"${DEVSPACE_OAUTH_OWNER_TOKEN-unset}\"", root),
    (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === 126,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
