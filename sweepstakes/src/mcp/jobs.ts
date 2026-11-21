// 時間のかかる処理 (収集・一括応募など) のメモリ内ジョブ管理
// ブラウザ操作・収集は同時に 1 ジョブまで (排他ロック)。
import { randomUUID } from "node:crypto";

export type JobStatus = "running" | "succeeded" | "failed";

export interface Job<T = unknown> {
  id: string;
  kind: string;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  /** 進捗ログ (直近 MAX_LOG 行) */
  log: string[];
  result: T | null;
  error: string | null;
  /** 完了を待つための Promise (外部公開用ではない) */
  readonly done: Promise<void>;
}

export class JobBusyError extends Error {
  constructor(readonly running: Job) {
    super(`別のジョブ (${running.kind} / ${running.id}) が実行中です。get_job で完了を確認してから再実行してください`);
    this.name = "JobBusyError";
  }
}

const MAX_LOG = 200;

export interface JobManagerOptions {
  /** 完了済みジョブの保持数 */
  keepFinished?: number;
  now?: () => Date;
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private active: Job | null = null;
  private readonly keepFinished: number;
  private readonly now: () => Date;

  constructor(opts: JobManagerOptions = {}) {
    this.keepFinished = opts.keepFinished ?? 50;
    this.now = opts.now ?? (() => new Date());
  }

  /** 実行中の排他ジョブ */
  get running(): Job | null {
    return this.active;
  }

  /**
   * 排他ジョブを開始する。既に実行中なら JobBusyError。
   * run には進捗ログ関数が渡される。
   */
  start<T>(kind: string, run: (log: (msg: string) => void) => Promise<T>): Job<T> {
    if (this.active) throw new JobBusyError(this.active);
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const job: Job<T> = {
      id: randomUUID(),
      kind,
      status: "running",
      startedAt: this.now().toISOString(),
      finishedAt: null,
      log: [],
      result: null,
      error: null,
      done,
    };
    const log = (msg: string) => {
      job.log.push(`${this.now().toISOString()} ${msg}`);
      if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
    };
    this.active = job as Job;
    this.jobs.set(job.id, job as Job);
    // 同期例外も非同期の失敗として扱う
    Promise.resolve()
      .then(() => run(log))
      .then(
        (r) => {
          job.status = "succeeded";
          job.result = r;
        },
        (e: unknown) => {
          job.status = "failed";
          job.error = e instanceof Error ? e.message : String(e);
        },
      )
      .finally(() => {
        job.finishedAt = this.now().toISOString();
        if (this.active === (job as Job)) this.active = null;
        this.trim();
        resolveDone();
      });
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()].reverse();
  }

  private trim(): void {
    const finished = [...this.jobs.values()].filter((j) => j.status !== "running");
    for (const j of finished.slice(0, Math.max(0, finished.length - this.keepFinished))) this.jobs.delete(j.id);
  }
}
