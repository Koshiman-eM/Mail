/** ブローカー呼び出しの締め切り (1 つの venue の遅延が損切りの判定を止めないように) */

export class DeadlineError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} が ${ms}ms 以内に終わりませんでした (締め切り)`);
    this.name = "DeadlineError";
  }
}

/**
 * p が ms 以内に終わらなければ DeadlineError で失敗させる (p 自体は止められないので裏で続く。その結果は捨てる)。
 * ms が 0 以下・非有限なら締め切りなし。
 */
export function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (!(ms > 0) || !Number.isFinite(ms)) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
  });
  // 締め切り後に p が失敗しても未処理の拒否にしない
  p.catch(() => undefined);
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** キーごとにまとめ、グループ間は並列・グループ内は順番どおりに実行する */
export async function runGrouped<T, K>(items: T[], keyOf: (x: T) => K, fn: (x: T) => Promise<void>): Promise<void> {
  const groups = new Map<K, T[]>();
  for (const x of items) {
    const k = keyOf(x);
    const g = groups.get(k);
    if (g) g.push(x);
    else groups.set(k, [x]);
  }
  await Promise.all(
    [...groups.values()].map(async (g) => {
      for (const x of g) await fn(x);
    }),
  );
}
