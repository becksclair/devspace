import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  createDevspaceShellSpawnHook,
  createShellRuntime,
  createSystemdSessionEnvironmentReader,
  currentShellEnvironment,
  mergePathEntries,
  parseManagerEnvironment,
  runConfiguredShell,
  userExecutablePaths,
} from "./shell-environment.js";

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
    // eslint-disable-next-line no-template-curly-in-string
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
    // eslint-disable-next-line no-template-curly-in-string
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
    // eslint-disable-next-line no-template-curly-in-string
    () => runConfiguredShell(loginRuntime, "printf 'oauth=%s\\n' \"${DEVSPACE_OAUTH_OWNER_TOKEN-unset}\"", root),
    (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === 126,
  );

  // Graphical-session variables are resolved from the live session at spawn
  // time, so a service started before login picks them up afterwards.
  assert.deepEqual(
    parseManagerEnvironment(JSON.stringify({ type: "as", data: ["WAYLAND_DISPLAY=wayland-1", "XDG_CURRENT_DESKTOP=KDE", "EMPTY=", "A=b=c", "=bad", "noequals", 7] })),
    { WAYLAND_DISPLAY: "wayland-1", XDG_CURRENT_DESKTOP: "KDE", EMPTY: "", A: "b=c" },
  );
  assert.throws(() => parseManagerEnvironment(JSON.stringify({ type: "s", data: "x" })), /Unexpected/);

  let clock = 0;
  let queries = 0;
  let managerOutput: string | Error = JSON.stringify({ type: "as", data: ["DISPLAY=:0"] });
  const reader = createSystemdSessionEnvironmentReader({}, {
    ttlMs: 1_000,
    failureTtlMs: 5_000,
    now: () => clock,
    query: () => {
      queries += 1;
      if (managerOutput instanceof Error) throw managerOutput;
      return managerOutput;
    },
  });
  assert.ok(reader);
  assert.deepEqual(reader(), { DISPLAY: ":0" });
  managerOutput = JSON.stringify({ type: "as", data: ["DISPLAY=:1"] });
  clock = 999;
  assert.deepEqual(reader(), { DISPLAY: ":0" }, "cached within the TTL");
  clock = 1_000;
  assert.deepEqual(reader(), { DISPLAY: ":1" }, "refreshed after the TTL");
  managerOutput = new Error("bus unavailable");
  clock = 2_000;
  assert.equal(reader(), undefined, "query failure yields no session overlay");
  managerOutput = JSON.stringify({ type: "as", data: ["DISPLAY=:2"] });
  clock = 6_999;
  assert.equal(reader(), undefined, "failures back off for the failure TTL");
  clock = 7_000;
  assert.deepEqual(reader(), { DISPLAY: ":2" }, "recovers after the failure TTL");
  assert.equal(queries, 4);

  let liveSession: Record<string, string> | undefined;
  const sessionRuntime = createShellRuntime({
    path: "/bin/bash",
    mode: "service",
    environment: { XDG_SESSION_TYPE: "configured-type" },
  }, ["XAUTHORITY"], { ...baseEnvironment, DISPLAY: "stale:9" }, { sessionEnvironment: () => liveSession });
  const printSession = "printf 'wayland=%s display=%s type=%s xauth=%s path=%s\\n' \"${WAYLAND_DISPLAY-unset}\" \"${DISPLAY-unset}\" \"${XDG_SESSION_TYPE-unset}\" \"${XAUTHORITY-unset}\" \"$PATH\"";
  const beforeLogin = await runConfiguredShell(sessionRuntime, printSession, root);
  assert.match(beforeLogin.stdout, /wayland=unset display=stale:9 type=configured-type xauth=unset /);

  liveSession = {
    WAYLAND_DISPLAY: "wayland-1",
    DISPLAY: ":0",
    XDG_SESSION_TYPE: "wayland",
    XAUTHORITY: "/run/user/1000/xauth",
    PATH: "/session/only/bin",
    UNRELATED_SESSION_VALUE: "ignored",
  };
  const afterLogin = await runConfiguredShell(sessionRuntime, printSession, root);
  assert.match(afterLogin.stdout, /wayland=wayland-1 display=:0 type=configured-type xauth=unset /);
  assert.doesNotMatch(afterLogin.stdout, /\/session\/only\/bin/);
  assert.equal(currentShellEnvironment(sessionRuntime).UNRELATED_SESSION_VALUE, undefined);
  assert.equal(sessionRuntime.environment.WAYLAND_DISPLAY, undefined, "startup snapshot is not mutated");
  const hooked = createDevspaceShellSpawnHook(sessionRuntime)({ command: "true", cwd: root, env: {} });
  assert.equal(hooked.env?.WAYLAND_DISPLAY, "wayland-1");
  assert.equal(hooked.env?.PWD, root);

  const disabledRuntime = createShellRuntime({ path: "/bin/bash", mode: "service" }, [], baseEnvironment, { sessionEnvironment: false });
  assert.equal(disabledRuntime.readSessionEnvironment, undefined);
  assert.equal(currentShellEnvironment(disabledRuntime), disabledRuntime.environment);
} finally {
  await rm(root, { recursive: true, force: true });
}
