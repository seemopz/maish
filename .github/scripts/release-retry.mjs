// Decides whether a failed release run is re-run automatically. Only for jobs
// that never ran: GitHub cancels a job it cannot find a hosted runner for
// ("The job was not acquired by Runner of type hosted even after multiple
// attempts"; macOS arm64 under capacity constraints, 0.11.1). Such a job has no
// runner and no steps. A job that ran and failed is left alone, also when it
// sits next to a runner problem: re-running failed jobs would repeat it.
//
// Usage: node release-retry.mjs <jobs.json> <run attempt>
//   jobs.json: the run attempt's jobs (GitHub API), exit 0 = re-run, 1 = do not.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The run is given up after this attempt; 3 = two automatic re-runs. */
export const MAX_ATTEMPTS = 3;

const neverRan = (job) => !job.runner_name && (job.steps ?? []).length === 0;

/** Whether `jobs` (one run attempt) failed only because jobs got no runner. */
export function shouldRetry(jobs, attempt) {
  if (attempt >= MAX_ATTEMPTS) return false;
  // skipped: a dependent of a failed job, it has no runner either.
  const bad = jobs.filter((j) => j.conclusion !== "success" && j.conclusion !== "skipped");
  return bad.length > 0 && bad.every(neverRan);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const jobs = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const attempt = Number(process.argv[3]);
  const retry = shouldRetry(jobs, attempt);
  for (const j of jobs.filter((j) => j.conclusion !== "success" && j.conclusion !== "skipped")) {
    console.log(`${j.name}: ${j.conclusion}${neverRan(j) ? ", never got a runner" : ""}`);
  }
  console.log(retry ? `attempt ${attempt}: re-running the failed jobs` : `attempt ${attempt}: no automatic re-run`);
  process.exit(retry ? 0 : 1);
}
