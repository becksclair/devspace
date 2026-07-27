import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { expandHomePath } from "./roots.js";

export interface MachineConfig {
  id: string;
  aliases?: string[];
  displayName: string;
  canonical?: boolean;
  kind: "local" | "remote";
  allowedRoots?: string[];
  stateDir?: string;
  worktreeRoot?: string;
  url?: string;
  nodeTokenEnv?: string;
}

export interface GatewayRoleConfig {
  role: "gateway";
  host: string;
  port: number;
  publicBaseUrl: string;
  stateDir: string;
  machines: MachineConfig[];
}

export interface NodeRoleConfig {
  role: "node";
  host: "127.0.0.1";
  port: number;
  machineId: string;
  allowedRoots: string[];
  stateDir: string;
  worktreeRoot: string;
  nodeTokenEnv: string;
}

export type RoleConfig = GatewayRoleConfig | NodeRoleConfig;

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
function pathValue(value: unknown, name: string): string { return resolve(expandHomePath(nonEmpty(value, name))); }
function norm(value: string): string { return value.trim().toLowerCase(); }
function overlaps(a: string, b: string): boolean { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }

export function loadRoleConfig(filePath: string, env: NodeJS.ProcessEnv = process.env): RoleConfig {
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  const role = raw.role === undefined
    ? Array.isArray(raw.machines) ? "gateway" : raw.machineId !== undefined ? "node" : ""
    : nonEmpty(raw.role, "role");
  if (role === "node") {
    const host = raw.host ?? "127.0.0.1";
    if (host !== "127.0.0.1") throw new Error("node host must be 127.0.0.1");
    const nodeTokenEnv = nonEmpty(raw.nodeTokenEnv, "nodeTokenEnv");
    envSecret(nodeTokenEnv, env);
    const stateDir = pathValue(raw.stateDir, "stateDir");
    const worktreeRoot = pathValue(raw.worktreeRoot, "worktreeRoot");
    if (overlaps(stateDir, worktreeRoot)) throw new Error("node stateDir and worktreeRoot must not overlap");
    return {
      role: "node", host, port: parsePort(raw.port, "port"), machineId: norm(nonEmpty(raw.machineId, "machineId")),
      allowedRoots: paths(raw.allowedRoots, "allowedRoots"), stateDir,
      worktreeRoot, nodeTokenEnv,
    };
  }
  if (role !== "gateway") throw new Error(`Unknown role: ${role}`);
  const machinesRaw = raw.machines;
  if (!Array.isArray(machinesRaw) || machinesRaw.length === 0) throw new Error("machines must be a non-empty array");
  const machines = machinesRaw.map((item, index) => parseMachine(item as Record<string, unknown>, index));
  const names = new Set<string>();
  for (const machine of machines) for (const name of [machine.id, ...(machine.aliases ?? [])]) {
    const key = norm(name); if (!key || names.has(key)) throw new Error(`Duplicate machine id or alias: ${name}`); names.add(key);
  }
  if (machines.filter((m) => m.canonical === true).length !== 1) throw new Error("exactly one canonical machine is required");
  const stateDir = pathValue(raw.stateDir, "stateDir");
  const ownedRoots = [stateDir];
  for (const machine of machines.filter((m) => m.kind === "local")) {
    if (!machine.stateDir || !machine.worktreeRoot) throw new Error(`local machine ${machine.id} requires stateDir and worktreeRoot`);
    if (overlaps(stateDir, machine.stateDir) || overlaps(stateDir, machine.worktreeRoot) || overlaps(machine.stateDir, machine.worktreeRoot)) {
      throw new Error(`gateway and local machine roots must not overlap (${machine.id})`);
    }
    for (const root of [machine.stateDir, machine.worktreeRoot]) {
      for (const existing of ownedRoots) if (overlaps(existing, root)) throw new Error(`gateway executor roots must be pairwise non-overlapping (${machine.id})`);
      ownedRoots.push(root);
    }
  }
  for (const machine of machines.filter((m) => m.kind === "remote")) {
    envSecret(machine.nodeTokenEnv!, env);
  }
  return { role: "gateway", host: nonEmpty(raw.host, "host"), port: parsePort(raw.port, "port"), publicBaseUrl: normalizeUrl(raw.publicBaseUrl), stateDir, machines };
}

function parseMachine(raw: Record<string, unknown>, index: number): MachineConfig {
  const kind = nonEmpty(raw.kind, `machines[${index}].kind`) as MachineConfig["kind"];
  if (kind !== "local" && kind !== "remote") throw new Error(`invalid machine kind: ${kind}`);
  const machine: MachineConfig = { id: norm(nonEmpty(raw.id, `machines[${index}].id`)), displayName: nonEmpty(raw.displayName, `machines[${index}].displayName`), canonical: raw.canonical === true, kind };
  machine.aliases = Array.isArray(raw.aliases) ? raw.aliases.map((x) => norm(nonEmpty(x, "alias"))) : [];
  if (kind === "local") { machine.allowedRoots = paths(raw.allowedRoots, "allowedRoots"); machine.stateDir = pathValue(raw.stateDir, "stateDir"); machine.worktreeRoot = pathValue(raw.worktreeRoot, "worktreeRoot"); }
  else {
    const url = normalizeUrl(raw.url); if (!url.startsWith("https://")) throw new Error(`remote machine ${machine.id} url must use https`); machine.url = url;
    machine.nodeTokenEnv = nonEmpty(raw.nodeTokenEnv, "nodeTokenEnv");
  }
  return machine;
}
function paths(value: unknown, name: string): string[] { if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a non-empty array`); return value.map((x) => pathValue(x, name)); }
function parsePort(value: unknown, name: string): number { const n = Number(value ?? 7676); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid ${name}`); return n; }
function normalizeUrl(value: unknown): string { const u = new URL(nonEmpty(value, "publicBaseUrl")); if (!["http:", "https:"].includes(u.protocol)) throw new Error("URL must use http or https"); u.hash = ""; u.search = ""; u.pathname = u.pathname.replace(/\/+$/, ""); return u.toString().replace(/\/$/, ""); }

export function envSecret(config: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[config]?.trim(); if (!value) throw new Error(`required environment variable is missing: ${config}`); return value;
}
export function constantTimeEqual(a: string, b: string): boolean { const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
