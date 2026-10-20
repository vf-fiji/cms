// Worker thread that runs developer-authored server functions. The main thread
// terminates this worker if a call runs past its time limit, which stops even
// a busy loop after an `await` — something a vm timeout alone can't do.
import { parentPort } from "node:worker_threads";
import { buildCmsApi, executeCode, toTransferable } from "./functions";

interface Job {
  id: number;
  code: string;
  args: Record<string, unknown>;
  timeoutMs: number;
}

parentPort!.on("message", async (job: Job) => {
  const outcome = await executeCode(job.code, { ...job.args, cms: buildCmsApi() }, job.timeoutMs);
  const message = { id: job.id, outcome: outcome.ok ? { ...outcome, result: toTransferable(outcome.result) } : outcome };
  try {
    parentPort!.postMessage(message);
  } catch {
    parentPort!.postMessage({
      id: job.id,
      outcome: {
        ok: false,
        error: "The function returned something that can't be sent back (a function, class instance or circular data). Return plain JSON-style data.",
        logs: outcome.logs,
        ms: outcome.ms,
      },
    });
  }
});
