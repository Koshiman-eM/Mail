import { useEffect, useState } from "react";
import { api } from "../api";
import type { DetectedEvent } from "../types";

const STATUS_LABEL: Record<DetectedEvent["status"], string> = {
  pending: "未登録",
  created: "カレンダー登録済み",
  dismissed: "却下済み",
  failed: "登録失敗",
};

export default function Events() {
  const [events, setEvents] = useState<DetectedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setEvents(await api.listEvents());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate(id: number) {
    setBusyId(id);
    try {
      await api.createEvent(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDismiss(id: number) {
    setBusyId(id);
    try {
      await api.dismissEvent(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section>
      <div className="section-header">
        <h2>検出された予定</h2>
        <button onClick={load} disabled={loading}>
          {loading ? "読み込み中..." : "更新"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {!loading && events.length === 0 && <p className="empty">検出された予定はまだありません。</p>}
      <ul className="event-list">
        {events.map((e) => (
          <li key={e.id} className={`event-card status-${e.status}`}>
            <div className="event-main">
              <div className="event-title">{e.title}</div>
              <div className="event-time">{new Date(e.startAt).toLocaleString("ja-JP")}</div>
              {e.location && <div className="event-location">📍 {e.location}</div>}
            </div>
            <div className="event-side">
              <span className="confidence">確度: {e.confidence}</span>
              <span className={`status status-${e.status}`}>{STATUS_LABEL[e.status]}</span>
              {(e.status === "pending" || e.status === "failed") && (
                <div className="event-actions">
                  <button disabled={busyId === e.id} onClick={() => handleCreate(e.id)}>
                    カレンダーに追加
                  </button>
                  <button disabled={busyId === e.id} onClick={() => handleDismiss(e.id)}>
                    却下
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
