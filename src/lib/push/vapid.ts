import { createECDH } from "node:crypto";
import * as webpush from "web-push";
import { prisma } from "../db/prisma";
import { env } from "../env";

/**
 * VAPID 鍵の取得。
 * 1. 環境変数 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY が両方あればそれを使う
 * 2. なければ DB (AppSecret: vapid.publicKey / vapid.privateKey) から読む
 * 3. DB にも無ければ生成して保存する (複数プロセスの同時生成は INSERT ... ON CONFLICT DO NOTHING で
 *    先勝ちにし、保存後に読み直すので全プロセスが同じ鍵を使う)
 * 公開鍵は常に秘密鍵から導出し直して検証するため、鍵ペアの不整合は起きない。
 */

export const VAPID_PUBLIC_KEY_NAME = "vapid.publicKey";
export const VAPID_PRIVATE_KEY_NAME = "vapid.privateKey";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** base64url の P-256 秘密鍵から非圧縮公開鍵 (base64url) を導出する */
export function derivePublicKey(privateKey: string): string {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
  return ecdh.getPublicKey().toString("base64url");
}

async function loadFromDb(): Promise<VapidKeys | null> {
  const rows = await prisma.appSecret.findMany({ where: { key: { in: [VAPID_PUBLIC_KEY_NAME, VAPID_PRIVATE_KEY_NAME] } } });
  const priv = rows.find((r) => r.key === VAPID_PRIVATE_KEY_NAME)?.value;
  if (!priv) return null;
  return { privateKey: priv, publicKey: derivePublicKey(priv) };
}

async function resolveKeys(): Promise<VapidKeys> {
  const envPub = env.vapidPublicKey;
  const envPriv = env.vapidPrivateKey;
  if (envPub && envPriv) return { publicKey: envPub, privateKey: envPriv };
  if (envPub || envPriv) console.warn("[push] VAPID_PUBLIC_KEY と VAPID_PRIVATE_KEY は両方設定してください。DB の鍵を使用します。");

  const existing = await loadFromDb();
  if (existing) return existing;

  const generated = webpush.generateVAPIDKeys();
  await prisma.appSecret.createMany({
    data: [
      // 秘密鍵を先に挿入: 競合時は同じ行で待ち合わせになり、先勝ちの鍵だけが残る
      { key: VAPID_PRIVATE_KEY_NAME, value: generated.privateKey },
      { key: VAPID_PUBLIC_KEY_NAME, value: generated.publicKey },
    ],
    skipDuplicates: true,
  });
  const stored = await loadFromDb();
  if (!stored) throw new Error("VAPID 鍵の保存に失敗しました");
  return stored;
}

const g = globalThis as unknown as { __vapidKeys?: Promise<VapidKeys> };

/** VAPID 鍵を取得し、web-push に設定する (プロセス内でキャッシュ。失敗時は次回再試行) */
export function getVapidKeys(): Promise<VapidKeys> {
  if (!g.__vapidKeys) {
    g.__vapidKeys = resolveKeys()
      .then((keys) => {
        webpush.setVapidDetails(env.vapidSubject, keys.publicKey, keys.privateKey);
        return keys;
      })
      .catch((e) => {
        g.__vapidKeys = undefined;
        throw e;
      });
  }
  return g.__vapidKeys;
}
