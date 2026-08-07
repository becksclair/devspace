import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createShellRuntime, mergePathEntries, runConfiguredShell, userExecutablePaths } from "./shell-environment.js";

const root = await mkdtemp(join(tmpdir(), "devspace-shell-test-"));
try {
  const bin = join(root, "bin");
  await mkdir(bin);
  const tool = join(bin, "devspace-user-tool");
  await writeFile(tool, "#!/bin/sh\necho user-tool-ok\n");
  await chmod(tool, 0o755);
  await writeFile(join(root, ".bash_profile"), [
    'export PATH="$HOME/bin:$PATH"',
    'export DEVSPACE_PROFILE_SOURCED="1"',
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

  const expectedUserPaths = [
    join(root, ".local", "bin"),
    join(root, "bin"),
    join(root, ".bun", "bin"),
    join(root, ".cargo", "bin"),
    join(root, ".local", "share", "mise", "shims"),
  ];
  assert.deepEqual(userExecutablePaths(baseEnvironment), expectedUserPaths);
  const xdgDataHome = join(root, "xdg-data");
  assert.ok(userExecutablePaths({ ...baseEnvironment, XDG_DATA_HOME: xdgDataHome }).includes(join(xdgDataHome, "mise", "shims")));
  assert.deepEqual(
    mergePathEntries([expectedUserPaths[0], expectedUserPaths[1]], `${expectedUserPaths[1]}${delimiter}/usr/bin${delimiter}/bin`),
    [expectedUserPaths[0], expectedUserPaths[1], "/usr/bin", "/bin"],
  );

  const serviceRuntime = createShellRuntime({ path: "/bin/bash", mode: "service" }, secretNames, baseEnvironment);
  assert.deepEqual(serviceRuntime.environment.PATH?.split(delimiter).slice(0, expectedUserPaths.length), expectedUserPaths);
  const serviceResult = await runConfiguredShell(
    serviceRuntime,
    "printf 'tool=%s\\n' \"$(command -v devspace-user-tool)\"; printf 'profile=%s\\n' \"${DEVSPACE_PROFILE_SOURCED-unset}\"; printf 'oauth=%s\\n' \"${DEVSPACE_OAUTH_OWNER_TOKEN-unset}\"",
    root,
  );
  assert.match(serviceResult.stdout, new RegExp(`tool=${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(serviceResult.stdout, /profile=unset/);
  assert.match(serviceResult.stdout, /oauth=unset/);

  const configuredRuntime = createShellRuntime({
    path: "/bin/bash",
    mode: "service",
    environment: {
      PATH: `/custom/bin${delimiter}${join(root, ".local", "bin")}${delimiter}/usr/bin`,
      BUN_INSTALL: join(root, "custom-bun"),
      CARGO_HOME: join(root, "custom-cargo"),
      MISE_DATA_DIR: join(root, "custom-mise"),
      PNPM_HOME: join(root, "custom-pnpm"),
    },
  }, [], baseEnvironment);
  assert.deepEqual(configuredRuntime.environment.PATH?.split(delimiter).slice(0, 7), [
    join(root, ".local", "bin"),
    join(root, "bin"),
    join(root, "custom-bun", "bin"),
    join(root, "custom-cargo", "bin"),
    join(root, "custom-mise", "shims"),
    join(root, "custom-pnpm"),
    "/custom/bin",
  ]);

  const loginRuntime = createShellRuntime({ path: "/bin/bash", mode: "login" }, secretNames, baseEnvironment);
  const loginResult = await runConfiguredShell(
    loginRuntime,
    "printf 'tool=%s\\n' \"$(command -v devspace-user-tool)\"; printf 'profile=%s\\n' \"${DEVSPACE_PROFILE_SOURCED-unset}\"; printf 'oauth=%s\\n' \"${DEVSPACE_OAUTH_OWNER_TOKEN-unset}\"; printf 'node=%s\\n' \"${DEVSPACE_ASGARD_NODE_TOKEN-unset}\"; printf 'dev=%s\\n' \"${DEVELOPMENT_API_TOKEN-unset}\"",
    root,
  );
  assert.match(loginResult.stdout, new RegExp(`tool=${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(loginResult.stdout, /profile=1/);
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
