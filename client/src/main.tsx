import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HostApp } from "./host/HostApp";
import { PlayerApp } from "./player/PlayerApp";
import { StageApp } from "./stage/StageApp";
import { Wordmark } from "./ui";
import "./styles.css";

function Landing() {
  return (
    <main className="phone">
      <Wordmark className="wordmark--phone" />
      <section className="phone__card">
        <h1 className="phone__title">This is a private event</h1>
        <p>Open the invitation link from your host to join.</p>
      </section>
    </main>
  );
}

function App() {
  const path = location.pathname.replace(/\/+$/, "");
  if (path === "/host") {
    document.title = "Control room · Friendsmas";
    return <HostApp />;
  }
  if (path === "/stage") {
    document.title = "Stage · Friendsmas";
    const code = new URLSearchParams(location.search).get("c") ?? "";
    return <StageApp code={code} />;
  }
  const join = path.match(/^\/e\/([a-z0-9]+)$/i);
  if (join) return <PlayerApp code={join[1].toLowerCase()} />;
  return <Landing />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
