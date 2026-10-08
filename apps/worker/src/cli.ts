/**
 * Worker CLI.
 *   migrate          apply SQL migrations
 *   run              the worker loop (one job at a time, graceful SIGTERM)
 *   demo             full offline pipeline (MODE=mock, in-memory PGlite), prints a summary
 *   setup-catalog    pin Printify blueprint/provider ids  [--type T --blueprint N --provider N] [--dry-run]
 *   hash-password    print DESK_PASSWORD_HASH (password from the terminal or stdin, never argv)
 *   check-gpu        Ollama /api/tags + imagegen /healthz; prints what is missing
 *   check-cloud      Nous key + models (catalog, prices, images) and fal key; prints what is missing
 *   status           caps, spend, product and job counts
 *   retry-failed     requeue failed jobs  [--kind K] [--job ID]
 * Usage: tsx apps/worker/src/cli.ts <command>   (in Docker: node --import tsx apps/worker/src/cli.ts <command>)
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadEnv, type Env } from '@etsy-agents/core/config/env.ts';
import { migrate } from '@etsy-agents/core/db/db.ts';
import type { ProductType } from '@etsy-agents/core/domain/types.ts';
import { cloudAgentsFor } from '@etsy-agents/core/orchestrator/caps.ts';
import { loadOrchestratorEnv, scopeEnvForLoad } from '@etsy-agents/core/orchestrator/config.ts';
import { createLogger, errorMessage } from '@etsy-agents/core/orchestrator/logger.ts';
import { Orchestrator } from '@etsy-agents/core/orchestrator/orchestrator.ts';
import { buildRuntime, openDb } from '@etsy-agents/core/orchestrator/runtime.ts';
import { scheduleDue } from '@etsy-agents/core/orchestrator/scheduler.ts';
import { flagInt, flagString, parseArgs } from './args.ts';
import { checkCloud, printCloudCheck } from './commands/checkCloud.ts';
import { checkGpu, printGpuCheck } from './commands/checkGpu.ts';
import { runDemo } from './commands/demo.ts';
import { hashPasswordCommand, readPassword } from './commands/hashPassword.ts';
import { printStatus, retryFailed } from './commands/ops.ts';
import { runWorkerLoop, startHeartbeat } from './commands/run.ts';
import { setupCatalog } from './commands/setupCatalog.ts';
import { consoleIo, type Io } from './io.ts';

export const USAGE = `Usage: cli <command>
  migrate                         apply database migrations
  run                             start the worker loop
  demo                            run the whole pipeline offline (mock mode, in-memory DB)
  setup-catalog [--type T] [--blueprint N --provider N] [--dry-run]
  hash-password [--cost N]        read a password (terminal or stdin) and print DESK_PASSWORD_HASH
  check-gpu                       check Ollama models and the imagegen sidecar
  check-cloud                     check the Nous key and models, and the fal key
  status                          caps, spend, products, jobs
  retry-failed [--kind K] [--job ID]`;

export interface CliContext {
  io: Io;
  env?: Env;
  rawEnv?: Record<string, string | undefined>;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout?: NodeJS.WritableStream;
}

export async function main(argv: readonly string[], ctx: CliContext = { io: consoleIo }): Promise<number> {
  const { io } = ctx;
  const args = parseArgs(argv, ['dry-run', 'help']);
  const getEnv = () => ctx.env ?? loadEnv(scopeEnvForLoad(ctx.rawEnv ?? process.env));
  switch (args.command) {
    case 'migrate': {
      // Only DATABASE_URL is needed: the one-shot migrate container gets no API keys (deploy/docker-compose.yml).
      const env = ctx.env ?? loadEnv(scopeEnvForLoad(ctx.rawEnv ?? process.env), { scope: 'database' });
      const { db, engine } = await openDb(env);
      try {
        const ran = await migrate(db);
        io.out(ran.length ? `Applied ${ran.join(', ')} (${engine})` : `Database is up to date (${engine})`);
      } finally {
        await db.close();
      }
      return 0;
    }

    case 'run': {
      const env = getEnv();
      const runtime = await buildRuntime(env, { component: 'worker', rawEnv: ctx.rawEnv ?? process.env });
      const { deps, settings } = runtime;
      const controller = new AbortController();
      const stop = (sig: string) => {
        if (controller.signal.aborted) return;
        deps.logger.info({ signal: sig }, 'stopping after the current job');
        controller.abort();
      };
      process.once('SIGTERM', () => stop('SIGTERM'));
      process.once('SIGINT', () => stop('SIGINT'));
      const stopHeartbeat = startHeartbeat(settings.WORKER_HEARTBEAT_PATH, deps.logger);
      deps.logger.info(
        { mode: env.MODE, llm: env.LLM_DEFAULT_PROVIDER, routes: Object.keys(env.LLM_ROUTES), imagegen: env.IMAGEGEN_PROVIDER },
        'worker started',
      );
      try {
        const orchestrator = new Orchestrator(deps, runtime.orchestratorOptions);
        const res = await runWorkerLoop({
          orchestrator,
          schedule: () => scheduleDue(deps.db, deps.now(), { trendScanHourUtc: settings.TREND_SCAN_HOUR_UTC }),
          pollMs: settings.WORKER_POLL_INTERVAL_MS,
          signal: controller.signal,
          logger: deps.logger,
        });
        deps.logger.info({ jobsRun: res.jobsRun }, 'worker stopped');
      } finally {
        stopHeartbeat();
        await runtime.close();
      }
      return 0;
    }

    case 'demo': {
      const raw = { ...(ctx.rawEnv ?? {}), MODE: 'mock', LOG_LEVEL: (ctx.rawEnv ?? process.env).LOG_LEVEL ?? 'warn' };
      const env = loadEnv(raw);
      const summary = await runDemo({ io, env });
      return summary.failedJobs.length === 0 && summary.drafted > 0 ? 0 : 1;
    }

    case 'setup-catalog': {
      const env = getEnv();
      const runtime = await buildRuntime(env, { component: 'setup-catalog', rawEnv: ctx.rawEnv ?? process.env });
      try {
        const type = flagString(args.flags, 'type') as ProductType | undefined;
        const blueprintId = flagInt(args.flags, 'blueprint');
        const printProviderId = flagInt(args.flags, 'provider');
        const res = await setupCatalog({
          db: runtime.deps.db,
          printify: runtime.deps.integrations.printify,
          shop: runtime.deps.shop,
          now: runtime.deps.now,
          io,
          ...(type ? { type } : {}),
          ...(blueprintId !== undefined ? { blueprintId } : {}),
          ...(printProviderId !== undefined ? { printProviderId } : {}),
          dryRun: args.flags['dry-run'] === true,
        });
        return res.failed.length ? 1 : 0;
      } finally {
        await runtime.close();
      }
    }

    case 'hash-password': {
      const cost = flagInt(args.flags, 'cost');
      const password = await readPassword((ctx.stdin ?? process.stdin) as never, (ctx.stdout ?? process.stderr) as never);
      io.out(await hashPasswordCommand(password, cost));
      return 0;
    }

    case 'check-gpu': {
      const env = getEnv();
      const res = await checkGpu(env);
      printGpuCheck(io, env, res);
      return res.ok ? 0 : 1;
    }

    case 'check-cloud': {
      // Parsed as in mock mode: the check reports missing cloud keys itself and must run before the Etsy, Printify
      // and Marker keys are filled in (formats are still validated).
      const env = ctx.env ?? loadEnv({ ...scopeEnvForLoad(ctx.rawEnv ?? process.env), MODE: 'mock' });
      const res = await checkCloud(env);
      printCloudCheck(io, env, loadOrchestratorEnv(ctx.rawEnv ?? process.env), res);
      return res.ok ? 0 : 1;
    }

    case 'status': {
      const env = getEnv();
      const { db } = await openDb(env);
      try {
        await printStatus(db, new Date(), cloudAgentsFor(env), io);
      } finally {
        await db.close();
      }
      return 0;
    }

    case 'retry-failed': {
      const env = getEnv();
      const { db } = await openDb(env);
      try {
        const kind = flagString(args.flags, 'kind');
        const jobId = flagString(args.flags, 'job');
        await retryFailed(db, new Date(), io, { ...(kind ? { kind } : {}), ...(jobId ? { jobId } : {}) });
      } finally {
        await db.close();
      }
      return 0;
    }

    case null:
    case 'help':
      io.out(USAGE);
      return args.command === null ? 2 : 0;

    default:
      io.err(`Unknown command: ${args.command}`);
      io.err(USAGE);
      return 2;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      const logger = createLogger(process.env.LOG_LEVEL ?? 'info', 'cli');
      logger.error({ err: errorMessage(err) }, 'command failed');
      process.exitCode = 1;
    },
  );
}
