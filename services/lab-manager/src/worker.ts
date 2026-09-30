import type { LabManager } from "./manager.js";

/**
 * What the orchestrator may ask of a lab host. The local LabManager implements
 * it directly; a deployment runs the same methods on dedicated, isolated lab
 * workers (the API process never needs a Docker socket) and exposes them
 * through a queue-backed client with the same signatures.
 */
export type LabWorker = Pick<
  LabManager,
  "createLab" | "runCommand" | "writeScratchFile" | "inspectFiles" | "readArtifact" | "freezeLab" | "destroyLab" | "cancelLab"
>;
