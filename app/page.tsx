import { config } from "@/lib/config";
import CreateBinButton from "./create-bin-button";

export default function Landing() {
  return (
    <main className="landing">
      <header className="landing-head">
        <div className="wordmark">
          hook<em>scope</em>
        </div>
        <div className="wordmark-sub">webhook inspector</div>
      </header>

      <section className="landing-main">
        <p className="landing-kicker">/// signal intercept console</p>
        <h1 className="landing-title">
          Catch every webhook.
          <br />
          <em>Inspect it. Replay it.</em>
        </h1>
        <p className="landing-sub">
          Open a bin and you get a temporary URL. Point any webhook, curl, or
          misbehaving integration at it. Every request shows up here live, with
          headers, body and timing laid bare, and one click resends it anywhere.
        </p>
        <CreateBinButton />
      </section>

      <footer className="landing-foot">
        <span>no sign-up · bins expire after {config.binTtlHours}h idle</span>
        <span>any method, any path</span>
        <span>live over server-sent events</span>
      </footer>
    </main>
  );
}
