import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { sha256 } from "@lineageguard/domain";
import { ValidationError } from "./errors.js";

export interface FixedCommand {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  stdin?: string;
  env?: Readonly<Record<string, string>>;
  executableDigest?: string;
  interpreter?: { path: string; digest: string };
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: FixedCommand): Promise<CommandResult>;
}

const trustedSystemPath = "/usr/bin:/bin";

async function assertImmutableExecutable(path: string, expectedDigest: string): Promise<void> {
  const metadata = await lstat(path).catch(() => undefined);
  if (
    !metadata?.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.uid !== 0 && metadata.uid !== process.getuid?.()) ||
    (metadata.uid === 0 ? (metadata.mode & 0o022) !== 0 : (metadata.mode & 0o222) !== 0) ||
    (metadata.mode & 0o111) === 0 ||
    sha256((await readFile(path)).toString("base64")) !== expectedDigest
  ) {
    throw new ValidationError("MISSING_TOOL", "trusted executable identity changed");
  }
}

export class SpawnCommandRunner implements CommandRunner {
  async run(command: FixedCommand): Promise<CommandResult> {
    if (command.executableDigest) {
      await assertImmutableExecutable(command.executable, command.executableDigest);
    }
    if (command.interpreter) {
      await assertImmutableExecutable(command.interpreter.path, command.interpreter.digest);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let outputBytes = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const child = spawn(command.executable, [...command.args], {
        cwd: command.cwd,
        env: {
          ...command.env,
          PATH: trustedSystemPath,
          HOME: command.cwd,
          XDG_CONFIG_HOME: command.cwd,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
        shell: false,
        detached: process.platform !== "win32",
        stdio: [command.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      const killProcessTree = () => {
        if (child.pid && process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch {
            // The process may have exited between the deadline and the kill.
          }
        }
        child.kill("SIGKILL");
      };
      const fail = (error: ValidationError) => {
        if (settled) return;
        settled = true;
        killProcessTree();
        reject(error);
      };
      const collect = (target: Buffer[], chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > command.maxOutputBytes) {
          fail(new ValidationError("OUTPUT_LIMIT", "command output exceeded configured limit"));
          return;
        }
        target.push(chunk);
      };
      child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.once("error", (error: NodeJS.ErrnoException) => {
        fail(
          new ValidationError(
            error.code === "ENOENT" ? "MISSING_TOOL" : "COMMAND_FAILED",
            error.code === "ENOENT"
              ? "required executable is unavailable"
              : "command launch failed",
          ),
        );
      });
      const timer = setTimeout(
        () => fail(new ValidationError("COMMAND_TIMEOUT", "command deadline exceeded")),
        command.timeoutMs,
      );
      child.once("close", async (exitCode) => {
        clearTimeout(timer);
        if (settled) return;
        try {
          if (command.executableDigest) {
            await assertImmutableExecutable(command.executable, command.executableDigest);
          }
          if (command.interpreter) {
            await assertImmutableExecutable(command.interpreter.path, command.interpreter.digest);
          }
        } catch {
          fail(new ValidationError("MISSING_TOOL", "trusted executable changed during execution"));
          return;
        }
        settled = true;
        resolve({
          exitCode: exitCode ?? -1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
      if (command.stdin !== undefined) child.stdin?.end(command.stdin);
    });
  }
}

export async function runRequired(
  runner: CommandRunner,
  command: FixedCommand,
): Promise<CommandResult> {
  const result = await runner.run(command);
  if (result.exitCode !== 0) {
    throw new ValidationError("COMMAND_FAILED", `exit_code=${result.exitCode}`);
  }
  return result;
}
