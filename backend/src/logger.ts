// Shared pino logger factory.
//
// One root pino instance is built at process start and threaded through
// the whole backend: Fastify (`loggerInstance`), the indexer runtime,
// the mempool poller, the ogmios-tx clients, and the db-sync client all
// receive `module:`-tagged child loggers so log aggregators can filter
// on a single field instead of the legacy `[prefix]` strings.
//
// Env knobs:
//   - LOG_LEVEL:  pino level (`fatal|error|warn|info|debug|trace|silent`).
//                 Default `info`.
//   - LOG_PRETTY: `1` to render pino-pretty for terminals. Default is
//                 `1` when NODE_ENV !== "production", else `0` (JSON).
//                 Vitest runs go silent unless explicitly opted in via
//                 LOG_LEVEL.
//
// The factory returns a `pino.Logger`; child loggers are produced via
// `logger.child({ module: "indexer" })`. Callers that don't have a
// pino instance handy in a test path can call `silentLogger()`.

import pino, { type Logger, type LoggerOptions } from "pino";

export type LovejoinLogger = Logger;

export interface BuildLoggerOptions {
  /** Optional `name` field set on every record (handy for multi-process logs). */
  name?: string;
  /** Force pretty-printing on/off. When omitted, env-driven (see above). */
  pretty?: boolean;
  /** Force level. When omitted, env-driven (see above). */
  level?: pino.LevelWithSilent;
}

export function buildLogger(opts: BuildLoggerOptions = {}): LovejoinLogger {
  const level = opts.level ?? defaultLevel();
  const pretty = opts.pretty ?? defaultPretty();

  const base: LoggerOptions = { level };
  if (opts.name) base.name = opts.name;

  if (pretty) {
    base.transport = {
      target: "pino-pretty",
      options: {
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname",
        singleLine: true,
      },
    };
  }
  return pino(base);
}

/** Pino instance with all output suppressed; the test default. */
export function silentLogger(): LovejoinLogger {
  return pino({ level: "silent" });
}

function defaultLevel(): pino.LevelWithSilent {
  const fromEnv = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (fromEnv && isLevel(fromEnv)) return fromEnv;
  // Vitest sets `VITEST=true`; keep tests quiet unless an operator
  // explicitly bumped LOG_LEVEL to debug a flaky run.
  if (process.env.VITEST) return "silent";
  return "info";
}

function defaultPretty(): boolean {
  const fromEnv = process.env.LOG_PRETTY?.trim();
  if (fromEnv === "1" || fromEnv === "true") return true;
  if (fromEnv === "0" || fromEnv === "false") return false;
  if (process.env.VITEST) return false;
  return process.env.NODE_ENV !== "production";
}

const LEVELS: pino.LevelWithSilent[] = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
];

function isLevel(s: string): s is pino.LevelWithSilent {
  return (LEVELS as string[]).includes(s);
}
