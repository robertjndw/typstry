import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");

/**
 * Builds the CLI and returns the path of the binary. A no-op when it's
 * current, which it is on CI.
 */
export async function buildCli() {
  await run("cargo", ["build", "--quiet", "-p", "typstry-cli"], {
    cwd: root,
  });
  return path.join(root, "target/debug/typstry");
}

/**
 * Keeps the machine's git config out, since it can change the default
 * branch or the committer.
 */
export function gitEnv() {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

/** Also keeps TYPSTRY_LINK out, which would make `clone` ignore its argument. */
function cleanEnv(author: string) {
  const env: NodeJS.ProcessEnv = gitEnv();
  for (const key of Object.keys(env)) {
    if (key.startsWith("TYPSTRY_")) delete env[key];
  }
  return {
    ...env,
    // A command that tries to open a browser fails instead.
    TYPSTRY_BROWSER: "/nonexistent/typstry-test-browser",
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: `${author.toLowerCase()}@example.com`,
    GIT_COMMITTER_NAME: author,
    GIT_COMMITTER_EMAIL: `${author.toLowerCase()}@example.com`,
  };
}

export type Run = { stdout: string; stderr: string; code: number };

/** Runs the `typstry` binary as one person. */
export class Cli {
  private readonly running = new Set<ChildProcess>();

  readonly binary: string;
  readonly name: string;

  constructor(binary: string, name: string) {
    this.binary = binary;
    this.name = name;
  }

  private args(dir: string, args: string[]) {
    return ["-C", dir, "--name", this.name, ...args];
  }

  /** Runs a command to the end. Doesn't throw when it fails. */
  async exec(dir: string, args: string[]): Promise<Run> {
    try {
      const { stdout, stderr } = await run(this.binary, this.args(dir, args), {
        cwd: dir,
        env: cleanEnv(this.name),
        timeout: 60_000,
      });
      return { stdout, stderr, code: 0 };
    } catch (error) {
      // A timeout or a missing binary leaves no exit code and maybe no
      // output, so keep the error message.
      const { stdout = "", stderr = "", code, message } = error as Run & Error;
      return {
        stdout,
        stderr: typeof code === "number" ? stderr : `${message}\n${stderr}`,
        code: typeof code === "number" ? code : 1,
      };
    }
  }

  /** Like `exec`, but throws when the command fails. */
  async ok(dir: string, args: string[]): Promise<Run> {
    const result = await this.exec(dir, args);
    if (result.code !== 0) {
      throw new Error(
        `typstry ${args.join(" ")} failed:\n${result.stderr}${result.stdout}`,
      );
    }
    return result;
  }

  /** Like `exec`, but throws when the command works. Returns stderr. */
  async refused(dir: string, args: string[]) {
    const result = await this.exec(dir, args);
    if (result.code === 0) {
      throw new Error(`typstry ${args.join(" ")} succeeded:\n${result.stdout}`);
    }
    return result.stderr;
  }

  /** Starts `typstry sync` and waits until it has connected. */
  async sync(dir: string) {
    const child = spawn(this.binary, this.args(dir, ["sync"]), {
      cwd: dir,
      env: cleanEnv(this.name),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.running.add(child);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    // A failed spawn emits "error" instead of "exit", and an unhandled
    // one crashes the worker.
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", (error) => {
        output += `${error.message}\n`;
        resolve();
      });
    });
    let done = false;
    void exited.then(() => (done = true));

    const handle = {
      output: () => output,
      /** SIGINT, like Ctrl+C, so it flushes before it exits. */
      stop: async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGINT");
        }
        const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        await exited;
        clearTimeout(killer);
        this.running.delete(child);
        return output;
      },
    };
    // Saves before this would only be seen by the startup scan, not the
    // file watcher.
    const deadline = Date.now() + 30_000;
    while (!output.includes("sync: connected")) {
      if (done || Date.now() > deadline) {
        await handle.stop();
        throw new Error(`typstry sync did not start:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return handle;
  }

  /**
   * Kills any sync still running, so a failed test can't leak one, and
   * waits for them to exit so their folder can be deleted.
   */
  async dispose() {
    const children = [...this.running].filter(
      (child) => child.exitCode === null && child.signalCode === null,
    );
    this.running.clear();
    await Promise.all(
      children.map((child) => {
        const gone = once(child, "exit");
        child.kill("SIGKILL");
        return gone;
      }),
    );
  }
}
