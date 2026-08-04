import { useEffect, useState } from "react";
import { api } from "../api";
import type { UnifiedMessage } from "../types";

const SOURCE_LABEL: Record<UnifiedMessage["source"], string> = {
  gmail: "Gmail",
  line: "LINE",
};

export default function Inbox() {
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setMessages(await api.listMessages());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <section>
      <div className="section-header">
        <h2>統合受信トレイ</h2>
        <button onClick={load} disabled={loading}>
          {loading ? "読み込み中..." : "更新"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {!loading && messages.length === 0 && (
        <p className="empty">メッセージがありません。設定画面からアカウントを連携するか、デモデータを投入してください。</p>
      )}
      <ul className="message-list">
        {messages.map((m) => (
          <li key={m.id} className="message-card">
            <div className="message-meta">
              <span className={`badge badge-${m.source}`}>{SOURCE_LABEL[m.source]}</span>
              <span className="sender">{m.sender}</span>
              <span className="time">{new Date(m.receivedAt).toLocaleString("ja-JP")}</span>
            </div>
            {m.subject && <div className="subject">{m.subject}</div>}
            <div className="body">{m.body}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
