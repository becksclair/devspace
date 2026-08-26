import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { expandHomePath } from "./roots.js";
import type { RootPolicy } from "./roots.js";
import { isTailnetHost, isTailnetUrl } from "./tailnet.js";

export interface RoleTerminalConfig {
  backend?: "tmux";
  runtimeDir?: string;
  maxPerWorkspace?: number;
  maxTotal?: number;
  idleTtlSeconds?: number;
  useUserSystemd?: boolean;
}

export interface MachineConfig {
  id: string;
  aliases?: string[];
  displayName: string;
  canonical?: boolean;
  kind: "local" | "remote";
  allowedRoots?: string[];
  roots?: RootPolicy[];
  shell?: { path?: string; mode?: "service" | "login"; environment?: Record<string, string> };
  terminals?: RoleTerminalConfig;
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
  host: string;
  port: number;
  machineId: string;
  allowedRoots?: string[];
  roots?: RootPolicy[];
  stateDir: string;
  worktreeRoot: string;
  nodeTokenEnv: string;
  shell?: { path?: string; mode?: "service" | "login"; environment?: Record<string, string> };
  terminals?: RoleTerminalConfig;
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
    const hostRaw = raw.host ?? "127.0.0.1";
    if (typeof hostRaw !== "string" || !hostRaw.trim()) throw new Error("node host must be a non-empty string");
    const host = hostRaw.trim();
    if (host !== "127.0.0.1" && !isTailnetHost(host)) throw new Error("node host must be 127.0.0.1 or a Tailnet IP/hostname (*.ts.net, 100.64.0.0/10, fd7a:115c:a1e0::/48)");
    const nodeTokenEnv = nonEmpty(raw.nodeTokenEnv, "nodeTokenEnv");
    envSecret(nodeTokenEnv, env);
    const stateDir = pathValue(raw.stateDir, "stateDir");
    const worktreeRoot = pathValue(raw.worktreeRoot, "worktreeRoot");
    if (overlaps(stateDir, worktreeRoot)) throw new Error("node stateDir and worktreeRoot must not overlap");
    const rootConfig = parseRootConfig(raw, "node");
    return {
      role: "node", host, port: parsePort(raw.port, "port"), machineId: norm(nonEmpty(raw.machineId, "machineId")),
      ...rootConfig,
      stateDir,
      shell: parseShell(raw.shell, "shell"),
      terminals: parseTerminals(raw.terminals, "terminals"),
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
   if (kind === "local") {
    Object.assign(machine, parseRootConfig(raw, `machines[${index}]`));
    machine.shell = parseShell(raw.shell, `machines[${index}].shell`);
    machine.terminals = parseTerminals(raw.terminals, `machines[${index}].terminals`);
    machine.stateDir = pathValue(raw.stateDir, "stateDir");
    machine.worktreeRoot = pathValue(raw.worktreeRoot, "worktreeRoot");
  }
  else {
    const url = normalizeUrl(raw.url);
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`remote machine ${machine.id} url must use https or http`);
    if (parsed.protocol === "http:" && !isTailnetUrl(parsed)) {
      throw new Error(`remote machine ${machine.id} http is only allowed for Tailnet targets (*.ts.net, 100.64.0.0/10, fd7a:115c:a1e0::/48)`);
    }
    machine.url = url;
    machine.nodeTokenEnv = nonEmpty(raw.nodeTokenEnv, "nodeTokenEnv");
  }
  return machine;
}
function parseRootConfig(raw: Record<string, unknown>, name: string): Pick<MachineConfig, "allowedRoots" | "roots"> {
  if (raw.allowedRoots !== undefined && raw.roots !== undefined) {
    throw new Error(`${name} cannot define both allowedRoots and roots`);
  }
  if (raw.roots !== undefined) {
    if (!Array.isArray(raw.roots) || raw.roots.length === 0) throw new Error(`${name}.roots must be a non-empty array`);
    const roots = raw.roots.map((value, index) => parseRootPolicy(value, `${name}.roots[${index}]`));
    return { roots };
  }
  return { allowedRoots: paths(raw.allowedRoots, `${name}.allowedRoots`) };
}

function parseRootPolicy(value: unknown, name: string): RootPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const raw = value as Record<string, unknown>;
  const access = nonEmpty(raw.access, `${name}.access`);
  if (access !== "read-only" && access !== "read-write") throw new Error(`${name}.access must be read-only or read-write`);
  const aliases = raw.aliases === undefined ? undefined : optionalPaths(raw.aliases, `${name}.aliases`);
  return { path: pathValue(raw.path, `${name}.path`), aliases, access };
}

function parseShell(value: unknown, name: string): MachineConfig["shell"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const raw = value as Record<string, unknown>;
  const mode = raw.mode === undefined ? undefined : nonEmpty(raw.mode, `${name}.mode`);
  if (mode !== undefined && mode !== "service" && mode !== "login") throw new Error(`${name}.mode must be service or login`);
  const environment = raw.environment === undefined ? undefined : parseStringMap(raw.environment, `${name}.environment`);
  return {
    path: raw.path === undefined ? undefined : pathValue(raw.path, `${name}.path`),
    mode: mode as "service" | "login" | undefined,
    environment,
  };
}

function parseTerminals(value: unknown, name: string): RoleTerminalConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const raw = value as Record<string, unknown>;
  if (raw.backend !== undefined && raw.backend !== "tmux") throw new Error(`${name}.backend must be tmux`);
  return {
    backend: raw.backend as "tmux" | undefined,
    runtimeDir: raw.runtimeDir === undefined ? undefined : pathValue(raw.runtimeDir, `${name}.runtimeDir`),
    maxPerWorkspace: optionalPositiveInteger(raw.maxPerWorkspace, `${name}.maxPerWorkspace`),
    maxTotal: optionalPositiveInteger(raw.maxTotal, `${name}.maxTotal`),
    idleTtlSeconds: optionalPositiveInteger(raw.idleTtlSeconds, `${name}.idleTtlSeconds`),
    useUserSystemd: raw.useUserSystemd === undefined ? undefined : booleanValue(raw.useUserSystemd, `${name}.useUserSystemd`),
  };
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function parseStringMap(value: unknown, name: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") throw new Error(`${name}.${key} must be a string`);
    result[key] = entry;
  }
  return result;
}

function optionalPaths(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((entry) => pathValue(entry, name));
}
function paths(value: unknown, name: string): string[] { if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a non-empty array`); return value.map((x) => pathValue(x, name)); }
function parsePort(value: unknown, name: string): number { const n = Number(value ?? 7676); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid ${name}`); return n; }
function normalizeUrl(value: unknown): string { const u = new URL(nonEmpty(value, "publicBaseUrl")); if (!["http:", "https:"].includes(u.protocol)) throw new Error("URL must use http or https"); u.hash = ""; u.search = ""; u.pathname = u.pathname.replace(/\/+$/, ""); return u.toString().replace(/\/$/, ""); }

export function envSecret(config: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[config]?.trim(); if (!value) throw new Error(`required environment variable is missing: ${config}`); return value;
}
export function constantTimeEqual(a: string, b: string): boolean { const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
