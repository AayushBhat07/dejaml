import { spawn } from "node:child_process";

export type OutputStream = "stdout" | "stderr";

export type BoundedText = {
  text: string;
  bytes: number;
  truncated: boolean;
};

export type RuntimeCommandOptions = {
  maxOutputBytes?: number;
  onOutput?: (stream: OutputStream, chunk: string) => void;
  signal?: AbortSignal;
};

export type RuntimeCommandResult = {
  exitCode: number | null;
  stdout: BoundedText;
  stderr: BoundedText;
  aborted: boolean;
};

/**
 * The only way the Lab Manager reaches the container engine. Arguments are
 * passed as an argv array to the Docker CLI; no shell is ever involved.
 */
export interface ContainerRuntime {
  docker(args: readonly string[], options?: RuntimeCommandOptions): Promise<RuntimeCommandResult>;
}

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

export class BoundedCapture {
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  #kept = 0;
  #total = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Buffer): void {
    this.#total += chunk.length;
    const room = this.#limit - this.#kept;
    if (room <= 0) return;
    const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
    this.#chunks.push(kept);
    this.#kept += kept.length;
  }

  result(): BoundedText {
    return {
      text: Buffer.concat(this.#chunks).toString("utf8"),
      bytes: this.#total,
      truncated: this.#total > this.#kept,
    };
  }
}

export class DockerCliRuntime implements ContainerRuntime {
  readonly #binary: string;

  constructor(binary = process.env.DOCKER_BIN ?? "docker") {
    if (binary.trim() === "") throw new Error("DOCKER_BIN must not be empty");
    this.#binary = binary;
  }

  docker(
    args: readonly string[],
    options: RuntimeCommandOptions = {},
  ): Promise<RuntimeCommandResult> {
    const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(this.#binary, [...args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
          ...(process.env.DOCKER_CONTEXT ? { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT } : {}),
          ...(process.env.DOCKER_CONFIG ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG } : {}),
          ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        },
      });
      const stdout = new BoundedCapture(limit);
      const stderr = new BoundedCapture(limit);
      let aborted = false;
      const abort = (): void => {
        aborted = true;
        child.kill("SIGKILL");
      };
      if (options.signal?.aborted) abort();
      options.signal?.addEventListener("abort", abort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        options.onOutput?.("stdout", chunk.toString("utf8"));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        options.onOutput?.("stderr", chunk.toString("utf8"));
      });
      child.on("error", (error) => {
        options.signal?.removeEventListener("abort", abort);
        rejectPromise(error);
      });
      child.on("close", (code) => {
        options.signal?.removeEventListener("abort", abort);
        resolvePromise({
          exitCode: code,
          stdout: stdout.result(),
          stderr: stderr.result(),
          aborted,
        });
      });
    });
  }
}
