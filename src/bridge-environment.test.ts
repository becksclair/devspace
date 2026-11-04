import assert from "node:assert/strict";
import { bridgeChildEnvironment } from "./shell-environment.js";

const base = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  DEVSPACE_OAUTH_OWNER_TOKEN: "owner",
  GH_TOKEN: "gh",
  GITHUB_TOKEN: "ghub",
  SAGA_NODE_TOKEN: "node",
  CLOUDFLARE_TUNNEL_TOKEN: "infra",
  ASGARD_BEARER: "custom-node-bearer",
  UNDEFINED_VALUE: undefined,
};
const env = bridgeChildEnvironment(base, ["DEVSPACE_OAUTH_OWNER_TOKEN", "CLOUDFLARE_TUNNEL_TOKEN", "ASGARD_BEARER"]);
assert.equal(env.PATH, "/usr/bin");
assert.equal(env.HOME, "/home/u");
for (const name of ["DEVSPACE_OAUTH_OWNER_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "SAGA_NODE_TOKEN", "CLOUDFLARE_TUNNEL_TOKEN", "ASGARD_BEARER", "UNDEFINED_VALUE"]) {
  assert.equal(Object.hasOwn(env, name), false, `${name} must not reach bridge children`);
}
assert.throws(() => bridgeChildEnvironment(base, ["BAD-NAME"]), /Invalid DevSpace infrastructure secret name/);
console.log("bridge-environment checks passed");
