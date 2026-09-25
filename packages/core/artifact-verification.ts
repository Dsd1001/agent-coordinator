import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  assertDeliveryIdentity,
  type ArtifactRef,
  type DeliveryCheck,
  type ExpectedDeliveryBinding,
  type ObservedDelivery
} from "../protocol/src/index.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;

export interface ArtifactVerificationResult {
  artifact: ArtifactRef;
  result: DeliveryCheck["result"];
  actual_sha256?: string;
  size?: number;
  detail?: string;
}

export interface ArtifactVerificationReport {
  ok: boolean;
  artifacts: ArtifactVerificationResult[];
  checks: DeliveryCheck[];
}

export interface DeliveryAcceptanceReport extends ArtifactVerificationReport {
  identity_verified: true;
  delivery_status: ObservedDelivery["payload"]["status"];
  declared_checks: DeliveryCheck[];
}

function validateArtifactPath(path: string): string | undefined {
  if (!path) return "artifact path is required";
  if (path.includes("\0")) return "artifact path contains a NUL byte";
  if (path.includes("\\")) return "artifact path must use forward slashes";
  if (isAbsolute(path) || path.startsWith("/") || WINDOWS_DRIVE_PATTERN.test(path)) {
    return "artifact path must be workspace-relative";
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "")) return "artifact path contains an empty segment";
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "artifact path contains a traversal segment";
  }
  return undefined;
}

export function validateArtifactRefs(artifacts: readonly ArtifactRef[]): DeliveryCheck[] {
  const seenPaths = new Set<string>();
  return artifacts.map((artifact, index) => {
    const errors: string[] = [];
    const pathError = validateArtifactPath(artifact.path);
    if (pathError) errors.push(pathError);
    if (!SHA256_PATTERN.test(artifact.sha256)) errors.push("sha256 must be 64 lowercase hexadecimal characters");
    if (seenPaths.has(artifact.path)) errors.push("duplicate artifact path");
    seenPaths.add(artifact.path);
    return {
      name: `artifact[${index}].manifest`,
      result: errors.length === 0 ? "passed" : "failed",
      ...(errors.length === 0 ? {} : { detail: errors.join("; ") })
    };
  });
}

class SafeArtifactError extends Error {}

function safeFsDetail(error: unknown): string {
  const code = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
  if (code === "ENOENT") return "artifact file is missing";
  if (code === "EACCES" || code === "EPERM") return "artifact file is not readable";
  if (error instanceof SafeArtifactError) return error.message;
  return "artifact verification failed";
}

async function workspaceRoot(path: string): Promise<string> {
  const root = resolve(path);
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink()) throw new SafeArtifactError("workspace root must not be a symbolic link");
    if (!rootInfo.isDirectory()) throw new SafeArtifactError("workspace root must be a directory");
    return await realpath(root);
  } catch (error) {
    if (error instanceof SafeArtifactError) throw error;
    throw new SafeArtifactError("workspace root is unavailable");
  }
}

async function resolveArtifactFile(root: string, artifactPath: string): Promise<string> {
  let current = root;
  const segments = artifactPath.split("/");
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new SafeArtifactError("symbolic links are not allowed in artifact paths");
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new SafeArtifactError("artifact parent component is not a directory");
    }
    if (index === segments.length - 1 && !info.isFile()) {
      throw new SafeArtifactError("artifact must be a regular file");
    }
  }
  const canonical = await realpath(current);
  const fromRoot = relative(root, canonical);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new SafeArtifactError("artifact resolves outside the workspace");
  }
  return current;
}

function sameFileSnapshot(
  before: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
  after: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function verifyArtifactFile(root: string, artifact: ArtifactRef): Promise<ArtifactVerificationResult> {
  try {
    const path = await resolveArtifactFile(root, artifact.path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new SafeArtifactError("artifact must be a regular file");
      const hash = createHash("sha256");
      const stream = handle.createReadStream({ autoClose: false });
      for await (const chunk of stream) hash.update(chunk);
      const actualSha256 = hash.digest("hex");
      const after = await handle.stat();
      if (!sameFileSnapshot(before, after)) {
        throw new SafeArtifactError("artifact changed during verification");
      }
      const pathAfter = await resolveArtifactFile(root, artifact.path);
      const finalInfo = await lstat(pathAfter);
      if (finalInfo.dev !== after.dev || finalInfo.ino !== after.ino) {
        throw new SafeArtifactError("artifact path changed during verification");
      }
      if (actualSha256 !== artifact.sha256) {
        return {
          artifact,
          result: "failed",
          actual_sha256: actualSha256,
          size: after.size,
          detail: "sha256 mismatch"
        };
      }
      return { artifact, result: "passed", actual_sha256: actualSha256, size: after.size };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { artifact, result: "failed", detail: safeFsDetail(error) };
  }
}

export async function verifyArtifactRefs(
  workspacePath: string,
  artifacts: readonly ArtifactRef[]
): Promise<ArtifactVerificationReport> {
  const manifestChecks = validateArtifactRefs(artifacts);
  if (manifestChecks.some((check) => check.result !== "passed")) {
    return {
      ok: false,
      checks: manifestChecks,
      artifacts: artifacts.map((artifact, index) => ({
        artifact,
        result: manifestChecks[index].result === "failed" ? "failed" : "not_run",
        detail: manifestChecks[index].detail ?? "manifest validation failed before file verification"
      }))
    };
  }

  let root: string;
  try {
    root = await workspaceRoot(workspacePath);
  } catch (error) {
    const detail = safeFsDetail(error);
    return {
      ok: false,
      checks: [
        ...manifestChecks,
        { name: "artifact.workspace", result: "failed", detail }
      ],
      artifacts: artifacts.map((artifact) => ({ artifact, result: "not_run", detail }))
    };
  }

  const verified: ArtifactVerificationResult[] = [];
  for (const artifact of artifacts) verified.push(await verifyArtifactFile(root, artifact));
  const fileChecks: DeliveryCheck[] = verified.map((result, index) => ({
    name: `artifact[${index}].sha256`,
    result: result.result,
    ...(result.detail ? { detail: result.detail } : {})
  }));
  return {
    ok: verified.every((result) => result.result === "passed"),
    artifacts: verified,
    checks: [...manifestChecks, ...fileChecks]
  };
}

export async function verifyDeliveryForAcceptance(
  expected: ExpectedDeliveryBinding,
  observed: ObservedDelivery,
  workspacePath: string
): Promise<DeliveryAcceptanceReport> {
  // Identity is deliberately checked before workspace resolution or file I/O.
  assertDeliveryIdentity(expected, observed);

  const statusCheck: DeliveryCheck = {
    name: "delivery.status",
    result: observed.payload.status === "delivered" ? "passed" : "failed",
    ...(observed.payload.status === "delivered"
      ? {}
      : { detail: `delivery status is ${observed.payload.status}` })
  };
  const declaredPassed = observed.payload.checks.every((check) => check.result === "passed");
  const declaredCheck: DeliveryCheck = {
    name: "delivery.declared_checks",
    result: declaredPassed ? "passed" : "failed",
    ...(declaredPassed ? {} : { detail: "one or more worker-declared checks did not pass" })
  };
  const artifactReport = await verifyArtifactRefs(workspacePath, observed.payload.artifacts);
  const checks = [statusCheck, declaredCheck, ...artifactReport.checks];
  return {
    ok: statusCheck.result === "passed" && declaredCheck.result === "passed" && artifactReport.ok,
    identity_verified: true,
    delivery_status: observed.payload.status,
    declared_checks: observed.payload.checks.map((check) => ({ ...check })),
    artifacts: artifactReport.artifacts,
    checks
  };
}

export async function assertDeliveryReadyForAcceptance(
  expected: ExpectedDeliveryBinding,
  observed: ObservedDelivery,
  workspacePath: string
): Promise<DeliveryAcceptanceReport> {
  const report = await verifyDeliveryForAcceptance(expected, observed, workspacePath);
  if (!report.ok) {
    const failed = report.checks.filter((check) => check.result !== "passed").map((check) => check.name);
    throw new Error(`delivery verification failed: ${failed.join(", ")}`);
  }
  return report;
}
