import { ImageResponse } from "next/og";

export const alt = "hookscope: catch every webhook, inspect it, replay it";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Rendered once at build time into the social-share card for link previews.
export default function OpengraphImage() {
  const rows = [
    ["POST", "#ffb454", "/stripe/payment_intent.succeeded", "2.1 KB"],
    ["POST", "#ffb454", "/github/push", "8.4 KB"],
    ["GET", "#8ae98a", "/health?check=1", "0 B"],
    ["DELETE", "#ff7466", "/sessions/9", "0 B"],
  ];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#090c09",
          color: "#d9e4d2",
          padding: "64px 72px",
          fontFamily: "monospace",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 28 }}>
          <div style={{ display: "flex" }}>
            hook<span style={{ color: "#c8f74f" }}>scope</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, color: "#c8f74f", fontSize: 22 }}>
            <div style={{ width: 14, height: 14, borderRadius: 7, background: "#c8f74f" }} />
            LIVE
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 76, lineHeight: 1.05, display: "flex" }}>Catch every webhook.</div>
          <div style={{ fontSize: 76, lineHeight: 1.05, color: "#c8f74f", display: "flex" }}>
            Inspect it. Replay it.
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", border: "1px solid #2b372b" }}>
          {rows.map(([method, color, path, size], i) => (
            <div
              key={i}
              style={{
                display: "flex",
                padding: "12px 20px",
                fontSize: 22,
                borderTop: i === 0 ? "none" : "1px solid #1c241c",
                background: i === 0 ? "rgba(200,247,79,0.10)" : "transparent",
              }}
            >
              <div style={{ width: 120, color, display: "flex" }}>{method}</div>
              <div style={{ flex: 1, display: "flex" }}>{path}</div>
              <div style={{ color: "#57624f", display: "flex" }}>{size}</div>
            </div>
          ))}
        </div>
      </div>
    ),
    size
  );
}
