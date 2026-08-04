import { useState } from "react";
import Inbox from "./pages/Inbox";
import Events from "./pages/Events";
import Settings from "./pages/Settings";

type Tab = "inbox" | "events" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "inbox", label: "受信トレイ" },
  { id: "events", label: "予定" },
  { id: "settings", label: "設定" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("inbox");

  return (
    <div className="app">
      <header className="app-header">
        <h1>MessageHub</h1>
        <p className="tagline">LINE・Gmailを一元管理し、予定を自動でカレンダーに登録</p>
      </header>
      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={t.id === tab ? "tab active" : "tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main className="app-main">
        {tab === "inbox" && <Inbox />}
        {tab === "events" && <Events />}
        {tab === "settings" && <Settings />}
      </main>
    </div>
  );
}
