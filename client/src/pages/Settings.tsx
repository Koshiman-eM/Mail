import { useEffect, useState } from "react";
import { api } from "../api";
import type { AccountsResponse } from "../types";

export default function Settings() {
  const [accounts, setAccounts] = useState<AccountsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    try {
      setAccounts(await api.getAccounts());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleSyncGmail() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.syncGmail();
      setMessage(
        `Gmail同期完了: ${result.fetched}件取得, ${result.newMessages}件が新規, ${result.detectedEvents}件の予定を検出`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSeed() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.seedDemoData();
      setMessage("デモデータを投入しました。「受信トレイ」「予定」タブを確認してください。");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>設定</h2>
      {error && <p className="error">{error}</p>}
      {message && <p className="info">{message}</p>}

      <div className="settings-card">
        <h3>Gmail / Google カレンダー</h3>
        {accounts?.google.connected ? (
          <p className="ok">連携済みです。</p>
        ) : accounts?.google.configured ? (
          <>
            <p>Googleアカウントが未連携です。</p>
            <a href="/auth/google">
              <button>Googleアカウントを連携</button>
            </a>
          </>
        ) : (
          <p className="warn">
            サーバー側で GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が未設定です。README を参照して設定してください。
          </p>
        )}
        <button disabled={busy || !accounts?.google.connected} onClick={handleSyncGmail}>
          Gmailを今すぐ同期
        </button>
      </div>

      <div className="settings-card">
        <h3>LINE</h3>
        {accounts?.line.configured ? (
          <p className="ok">LINE Webhookの受信準備ができています。</p>
        ) : (
          <p className="warn">
            サーバー側で LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN が未設定です。README を参照して LINE
            Developers コンソールで Webhook URL を設定してください。
          </p>
        )}
      </div>

      <div className="settings-card">
        <h3>デモ</h3>
        <p>実際のGmail/LINE連携なしで、メッセージ統合と予定検出の動作を確認できます。</p>
        <button disabled={busy} onClick={handleSeed}>
          デモデータを投入
        </button>
      </div>
    </section>
  );
}
