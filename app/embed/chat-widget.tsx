"use client";

import { useState, useRef, useEffect } from "react";
import {
  type WidgetConfig,
  type WidgetLabels,
  DEFAULT_LABELS,
  resolveFont,
  googleFontsHref,
} from "@/lib/widget-config";
import { FIELD_LIMITS } from "@/lib/field-limits";
import { isRtlLang } from "@/lib/lang";
import { leadError, LEAD_LIMITS } from "@/lib/lead";

// Resume the same conversation for this long after the last message, across
// page loads, navigations, and tab close/reopen. Rolling: refreshed on every
// send. After this much inactivity, a new visit starts a fresh chat.
const CONVO_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function makeConvoId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
}

type Msg = {
  role: "user" | "assistant";
  content: string;
  suggestions?: string[];
  collectInfo?: boolean;
};

// Pick readable foreground (dark or white) for a given hex background.
function readable(bg: string): string {
  const h = bg.replace("#", "");
  if (h.length < 6) return "#0f172a";
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return L > 0.62 ? "#0f172a" : "#ffffff";
}

function Avatar({ config, size }: { config: WidgetConfig; size: number }) {
  if (!config.avatarUrl) return null;
  const radius = Math.round(size * 0.32);
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={config.avatarUrl}
      alt=""
      style={{
        height: size,
        width: size,
        borderRadius: radius,
        objectFit: "cover",
        flexShrink: 0,
      }}
    />
  );
}

function SuggestionChips({
  items,
  config,
  disabled,
  onPick,
  rtl,
}: {
  items: string[];
  config: WidgetConfig;
  disabled?: boolean;
  onPick: (q: string) => void;
  rtl?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
      {items.map((q, i) => (
        <button
          key={i}
          type="button"
          onClick={() => !disabled && onPick(q)}
          disabled={disabled}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            border: "1px solid rgba(0,0,0,.10)",
            background: "#ffffff",
            color: "#1f2937",
            fontSize: 15,
            lineHeight: 1.3,
            padding: "7px 11px",
            borderRadius: 14,
            cursor: disabled ? "default" : "pointer",
            opacity: disabled ? 0.55 : 1,
            textAlign: "start",
          }}
        >
          <span style={{ color: config.bubbleColor, fontWeight: 700 }}>
            {rtl ? "\u2039" : "\u203A"}
          </span>
          {q}
        </button>
      ))}
    </div>
  );
}

// The host page's hostname, passed by widget.js as ?host= on this iframe's URL.
// Lets us tell internal links (the business's own site -> open in the visitor's
// current tab) from external ones (open in a new tab). Falls back to the iframe
// referrer, then to "" (unknown), in which case every link is treated as
// external, which is the safe default and matches the old behavior. Computed
// once and cached.
let _hostDomain: string | null = null;
function hostDomain(): string {
  if (_hostDomain !== null) return _hostDomain;
  let h = "";
  try {
    if (typeof window !== "undefined") {
      const fromParam = new URLSearchParams(window.location.search).get("host");
      if (fromParam) h = fromParam;
      else if (document.referrer) h = new URL(document.referrer).hostname;
    }
  } catch {
    h = "";
  }
  _hostDomain = h.toLowerCase().replace(/^www\./, "");
  return _hostDomain;
}

// Internal when the link's host matches the host page's, or is a subdomain of
// it (or vice versa). Unknown host or unparseable URL -> not internal.
function isInternalHref(href: string, host: string): boolean {
  if (!host) return false;
  try {
    const linkHost = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
    return (
      linkHost === host ||
      linkHost.endsWith("." + host) ||
      host.endsWith("." + linkHost)
    );
  } catch {
    return false;
  }
}

function LinkButton({
  href,
  label,
  config,
}: {
  href: string;
  label: string;
  config: WidgetConfig;
}) {
  if (!/^https?:\/\//i.test(href)) return null;
  const internal = isInternalHref(href, hostDomain());
  return (
    <a
      href={href}
      target={internal ? "_top" : "_blank"}
      rel={internal ? undefined : "noopener noreferrer"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        maxWidth: "100%",
        padding: "8px 14px",
        borderRadius: 999,
        background: config.bubbleColor,
        color: readable(config.bubbleColor),
        textDecoration: "none",
        fontSize: 14,
        fontWeight: 600,
        boxShadow: "0 1px 2px rgba(0,0,0,.08)",
      }}
    >
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {internal ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M7 17 17 7M9 7h8v8" />
        </svg>
      )}
    </a>
  );
}

// Markdown link [label](url) or a bare URL (http/https or scheme-less www.),
// matched BEFORE emphasis so URL characters (including underscores) are never
// seen by the emphasis parser.
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)|((?:https?:\/\/|www\.)[^\s<]+)/g;
// Emphasis + inline code on a link-free text segment.
const EMPH_RE = /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\*([^*]+)\*|_([^_]+)_/g;

// Inline contact patterns, detected in link-free text. Email -> mailto. A full
// US-style address anchored by ", City, ST ZIP" -> Google Maps (the ZIP anchor
// keeps false positives rare). Phone numbers must be formatted (parentheses or
// separators, or a leading +) so bare ID/number runs and date ranges aren't
// matched.
const EMAIL_SRC = "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}";
const ADDRESS_SRC =
  "\\d{1,6}\\s+[A-Za-z0-9.,'#\\s-]{3,60}?,?\\s+[A-Za-z .'-]+,\\s*[A-Za-z]{2}\\s+\\d{5}(?:-\\d{4})?";
const PHONE_SRC =
  "(?:\\+\\d[\\d\\s().-]{6,}\\d)|(?:(?:\\+?1[\\s.-]?)?(?:\\(\\d{3}\\)\\s?|\\d{3}[\\s.-])\\d{3}[\\s.-]\\d{4})";
const CONTACT_RE = new RegExp(`(${EMAIL_SRC})|(${ADDRESS_SRC})|(${PHONE_SRC})`, "gi");

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9]/.test(ch);
}

// Render bold/italic/code on a segment that contains no links. Underscore
// emphasis follows the CommonMark rule and does NOT fire intraword, so handles
// and identifiers like sprout_pediatric_dentistry or get_user_id stay literal
// instead of turning the middle into italics.
function renderEmphasis(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  EMPH_RE.lastIndex = 0;
  while ((m = EMPH_RE.exec(text)) !== null) {
    const k = keyBase + "e" + i++;
    // __ (m[2]) and _ (m[5]) are underscore emphasis: skip when intraword.
    if (m[2] !== undefined || m[5] !== undefined) {
      const before = text[m.index - 1];
      const after = text[m.index + m[0].length];
      if (isWordChar(before) && isWordChar(after)) {
        out.push(text.slice(last, m.index + 1)); // keep through the opening _
        last = m.index + 1;
        EMPH_RE.lastIndex = m.index + 1;
        continue;
      }
    }
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={k}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<strong key={k}>{m[2]}</strong>);
    else if (m[3] !== undefined)
      out.push(
        <code key={k} style={{ background: "rgba(0,0,0,.06)", borderRadius: 4, padding: "0 4px", fontSize: 15 }}>
          {m[3]}
        </code>
      );
    else if (m[4] !== undefined) out.push(<em key={k}>{m[4]}</em>);
    else if (m[5] !== undefined) out.push(<em key={k}>{m[5]}</em>);
    last = EMPH_RE.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Within link-free text, turn emails into mailto:, full addresses into Google
// Maps links, and formatted phone numbers into tel:. Anything else flows
// through renderEmphasis so bold/italic/code still work around the contacts.
function renderContacts(
  text: string,
  config: WidgetConfig,
  keyBase: string
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const linkStyle: React.CSSProperties = {
    color: config.bubbleColor,
    textDecoration: "underline",
    wordBreak: "break-word",
    overflowWrap: "anywhere",
  };
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  CONTACT_RE.lastIndex = 0;
  while ((m = CONTACT_RE.exec(text)) !== null) {
    if (m.index > last) {
      out.push(...renderEmphasis(text.slice(last, m.index), keyBase + "t" + i));
    }
    const k = keyBase + "c" + i++;
    if (m[1] !== undefined) {
      out.push(
        <a key={k} href={"mailto:" + m[1]} style={linkStyle}>
          {m[1]}
        </a>
      );
    } else if (m[2] !== undefined) {
      const q = encodeURIComponent(m[2].replace(/\s+/g, " ").trim());
      out.push(
        <a
          key={k}
          href={"https://www.google.com/maps/search/?api=1&query=" + q}
          target="_blank"
          rel="noopener noreferrer"
          style={linkStyle}
        >
          {m[2]}
        </a>
      );
    } else if (m[3] !== undefined) {
      const tel = m[3].replace(/[^\d+]/g, "");
      const digitCount = tel.replace(/\D/g, "").length;
      if (digitCount >= 7 && digitCount <= 15) {
        out.push(
          <a key={k} href={"tel:" + tel} style={linkStyle}>
            {m[3]}
          </a>
        );
      } else {
        // Not a plausible phone number; leave the text as-is.
        out.push(m[3]);
      }
    }
    last = CONTACT_RE.lastIndex;
  }
  if (last < text.length) {
    out.push(...renderEmphasis(text.slice(last), keyBase + "t" + i));
  }
  return out;
}

function renderInline(
  text: string,
  config: WidgetConfig,
  keyBase: string
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text)) !== null) {
    if (m.index > last) {
      out.push(...renderContacts(text.slice(last, m.index), config, keyBase + "p" + i));
    }
    i++;
    if (m[1] !== undefined) {
      // Markdown link label stays inline; the clickable button renders below.
      out.push(m[1]);
    }
    // Bare URLs (m[3]) are shown as "Visit <domain>" buttons below the message
    // (collected in MessageContent), so they are dropped from the inline flow.
    last = LINK_RE.lastIndex;
  }
  if (last < text.length) {
    out.push(...renderContacts(text.slice(last), config, keyBase + "p" + i));
  }
  return out;
}

// Friendly button label for a bare URL: "Visit instagram.com" (host without www).
function visitLabel(href: string): string {
  try {
    const host = new URL(href).hostname.replace(/^www\./i, "");
    return host ? "Visit " + host : "Visit link";
  } catch {
    return "Visit link";
  }
}

function MessageContent({ text, config }: { text: string; config: WidgetConfig }) {
  // Collect links to render as buttons under the message. Markdown links keep
  // their given label; bare URLs become "Visit <domain>". One pass with the
  // same LINK_RE used for inline rendering, so a URL inside [..](..) is not
  // double-counted.
  const links: { label: string; url: string }[] = [];
  const seen = new Set<string>();
  LINK_RE.lastIndex = 0;
  let lm: RegExpExecArray | null;
  while ((lm = LINK_RE.exec(text)) !== null) {
    if (lm[1] !== undefined) {
      const url = lm[2];
      if (/^https?:\/\//i.test(url) && !seen.has(url)) {
        seen.add(url);
        links.push({ label: lm[1], url });
      }
    } else if (lm[3] !== undefined) {
      let shown = lm[3];
      const tm = shown.match(/[.,!?:;)\]}'"]+$/);
      if (tm) shown = shown.slice(0, shown.length - tm[0].length);
      const href = /^https?:\/\//i.test(shown) ? shown : "https://" + shown;
      if (!seen.has(href)) {
        seen.add(href);
        links.push({ label: visitLabel(href), url: href });
      }
    }
  }

  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let b = 0;
  const bullet = /^\s*[-*•]\s+/;
  const ordered = /^\s*\d+\.\s+/;

  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    if (bullet.test(lines[i])) {
      const items: string[] = [];
      while (i < lines.length && bullet.test(lines[i])) {
        items.push(lines[i].replace(bullet, ""));
        i++;
      }
      const bk = "b" + b++;
      blocks.push(
        <ul key={bk} style={{ margin: "2px 0 6px", paddingInlineStart: 22, listStyleType: "disc", listStylePosition: "outside" }}>
          {items.map((it, j) => (
            <li key={j} style={{ margin: "2px 0" }}>
              {renderInline(it, config, bk + "-" + j)}
            </li>
          ))}
        </ul>
      );
      continue;
    }
    if (ordered.test(lines[i])) {
      const items: string[] = [];
      while (i < lines.length && ordered.test(lines[i])) {
        items.push(lines[i].replace(ordered, ""));
        i++;
      }
      const bk = "b" + b++;
      blocks.push(
        <ol key={bk} style={{ margin: "2px 0 6px", paddingInlineStart: 26, listStyleType: "decimal", listStylePosition: "outside" }}>
          {items.map((it, j) => (
            <li key={j} style={{ margin: "2px 0" }}>
              {renderInline(it, config, bk + "-" + j)}
            </li>
          ))}
        </ol>
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !bullet.test(lines[i]) &&
      !ordered.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    const bk = "b" + b++;
    blocks.push(
      <p key={bk} style={{ margin: "0 0 6px" }}>
        {para.map((ln, j) => (
          <span key={j}>
            {renderInline(ln, config, bk + "-" + j)}
            {j < para.length - 1 ? <br /> : null}
          </span>
        ))}
      </p>
    );
  }

  return (
    <div style={{ marginBottom: links.length ? 0 : -6 }}>
      {blocks}
      {links.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6, marginTop: 8 }}>
          {links.map((l, j) => (
            <LinkButton key={j} href={l.url} label={l.label} config={config} />
          ))}
        </div>
      )}
    </div>
  );
}

function LeadForm({
  widgetKey,
  conversationId,
  contextMessage,
  labels,
  config,
  font,
  onCaptured,
}: {
  widgetKey: string;
  conversationId: string | null;
  contextMessage: string;
  labels: WidgetLabels;
  config: WidgetConfig;
  font: string;
  onCaptured: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canSubmit = (email.trim() || phone.trim()) && !busy && !done;

  const field: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    border: "1px solid rgba(0,0,0,.12)",
    borderRadius: 10,
    padding: "9px 11px",
    fontSize: 16, // 16px so iOS doesn't zoom on focus
    color: "#0f172a",
    background: "#fff",
    outline: "none",
    fontFamily: font,
  };

  // Field with room on the left for an inline icon.
  const fieldIcon: React.CSSProperties = { ...field, paddingLeft: 36 };
  const iconWrap: React.CSSProperties = { position: "relative", width: "100%" };
  const iconStyle: React.CSSProperties = {
    position: "absolute",
    left: 11,
    top: "50%",
    transform: "translateY(-50%)",
    pointerEvents: "none",
  };

  async function submit() {
    const v = leadError({ name, email, phone });
    if (v) {
      setErr(v);
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          widgetKey,
          conversationId,
          name,
          email,
          phone,
          message: contextMessage,
          hp: "",
        }),
      });
      if (!res.ok) throw new Error("bad status");
      setDone(true);
      onCaptured();
    } catch {
      setBusy(false);
      setErr(labels.leadError);
    }
  }

  if (done) {
    return (
      <div
        style={{
          marginTop: 8,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 12px",
          borderRadius: 12,
          background: config.assistantBubbleColor,
          color: config.textColor,
          fontSize: 15,
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke={config.bubbleColor}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0 }}
          aria-hidden="true"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
        <span>{labels.leadSent}</span>
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: 8,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        borderRadius: 14,
        border: "1px solid rgba(0,0,0,.10)",
        background: "#fff",
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      <div style={iconWrap}>
        <svg
          style={iconStyle}
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#0f172a"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={labels.leadName}
          maxLength={LEAD_LIMITS.name}
          style={fieldIcon}
        />
      </div>
      <div style={iconWrap}>
        <svg
          style={iconStyle}
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#0f172a"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m3 7 9 6 9-6" />
        </svg>
        <input
          type="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={labels.leadEmail}
          maxLength={LEAD_LIMITS.email}
          style={fieldIcon}
        />
      </div>
      <div style={iconWrap}>
        <svg
          style={iconStyle}
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#0f172a"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
        </svg>
        <input
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder={labels.leadPhone}
          maxLength={LEAD_LIMITS.phone}
          style={fieldIcon}
        />
      </div>
      {err && (
        <span style={{ fontSize: 13, color: "#dc2626" }} role="alert">
          {err}
        </span>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        style={{
          border: "none",
          borderRadius: 10,
          padding: "10px 12px",
          fontSize: 15,
          fontWeight: 600,
          color: "#fff",
          background: config.bubbleColor,
          cursor: canSubmit ? "pointer" : "default",
          opacity: canSubmit ? 1 : 0.55,
          fontFamily: font,
        }}
      >
        {labels.leadSubmit}
      </button>
    </div>
  );
}

export function ChatWidget({
  widgetKey,
  config,
  labels = DEFAULT_LABELS,
  lang = "",
  radius,
  onClose,
  pendingQuestion,
  onQuestionConsumed,
  visible = true,
}: {
  widgetKey: string;
  config: WidgetConfig;
  labels?: WidgetLabels;
  lang?: string;
  radius?: number;
  onClose?: () => void;
  pendingQuestion?: string;
  onQuestionConsumed?: () => void;
  visible?: boolean;
}) {
  const rtl = isRtlLang(lang);
  const dir = rtl ? "rtl" : "ltr";
  const [leadCaptured, setLeadCaptured] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([
    { role: "assistant", content: config.greeting },
  ]);
  const [input, setInput] = useState("");
  const [hp, setHp] = useState("");
  const [busy, setBusy] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastMsgRef = useRef<HTMLDivElement>(null);
  // Until the visitor sends their first live message, every message change
  // (the greeting, then any restored history) should land at the bottom so a
  // resumed chat opens where it left off rather than scrolled to the top.
  const initialScrollRef = useRef(true);
  // One stable id per chat so every turn threads into a single server-side
  // conversation (instead of a new row per message). Persisted in localStorage
  // with a rolling TTL so the chat resumes across reloads and tab reopens.
  const convoIdRef = useRef<string>("");
  const font = resolveFont(config.fontFamily);

  // Load the selected Google font inside the widget iframe (the host page may
  // not have it). Web-safe choices return null and skip the fetch.
  useEffect(() => {
    const href = googleFontsHref([config.fontFamily]);
    if (!href || typeof document === "undefined") return;
    const id = "bv-font-" + config.fontFamily;
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }, [config.fontFamily]);

  // Resume an existing chat if one is still within the TTL. This effect is
  // READ-ONLY by design: nothing is generated or written to localStorage at
  // load. The conversation id is created lazily on the visitor's first
  // message (see send handler), so an idle widget stores nothing on the
  // visitor's device. That keeps the widget consent-banner friendly.
  useEffect(() => {
    const storeKey = "bv_convo_" + widgetKey;
    let id = "";
    let resume = false;
    try {
      const raw = localStorage.getItem(storeKey);
      if (raw) {
        const saved = JSON.parse(raw) as { id?: string; ts?: number };
        if (
          saved &&
          typeof saved.id === "string" &&
          typeof saved.ts === "number" &&
          Date.now() - saved.ts < CONVO_TTL_MS
        ) {
          id = saved.id;
          resume = true;
        }
      }
    } catch {
      /* storage blocked or malformed; start fresh on first message */
    }
    if (!resume) return;
    convoIdRef.current = id;

    // Pull prior turns so the visitor sees the ongoing chat, not a blank one.
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/conversation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ widgetKey, conversationId: id }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        const prior = (Array.isArray(data.messages) ? data.messages : [])
          .filter(
            (m: unknown): m is { role: string; content: string } =>
              !!m && typeof m === "object"
          )
          .map((m: { role: string; content: unknown }) => ({
            role: m.role === "user" ? "user" : "assistant",
            content: String(m.content ?? ""),
          })) as Msg[];
        if (prior.length > 0) {
          // Only adopt history if the visitor hasn't already started typing a
          // brand-new chat in the meantime.
          setMessages((cur) =>
            cur.length <= 1
              ? [{ role: "assistant", content: config.greeting }, ...prior]
              : cur
          );
        }
        if (data.leadCaptured === true) setLeadCaptured(true);
      } catch {
        /* keep the fresh greeting on failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [widgetKey, config.greeting]);

  const headerBg = config.headerColor;
  const headerFg = readable(headerBg);
  // The footer sits on the panel background; pick the matching logo + muted
  // text color so "Powered by" stays legible on light or dark themes.
  const panelIsDark = readable(config.backgroundColor) === "#ffffff";

  useEffect(() => {
    const sc = scrollRef.current;
    // The panel is always mounted but hidden when closed, so it has no layout
    // (scrollHeight is 0) until it opens. Skip while hidden and let the visible
    // transition re-run this.
    if (!sc || !visible) return;
    // Initial load or a resumed conversation: snap to the bottom once the
    // restored messages have laid out, so the visitor sees the latest turn
    // instead of the greeting at the top. Instant (no smooth animation).
    if (initialScrollRef.current) {
      const jump = () => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      };
      requestAnimationFrame(() => requestAnimationFrame(jump));
      return;
    }
    const last = messages[messages.length - 1];
    // While sending / waiting, keep the newest content in view.
    if (busy || !last || last.role === "user") {
      sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" });
      return;
    }
    // A new answer arrived: align its TOP near the top so it reads from the start.
    const el = lastMsgRef.current;
    if (el) {
      const delta =
        el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
      sc.scrollTo({ top: sc.scrollTop + delta - 12, behavior: "smooth" });
    } else {
      sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" });
    }
  }, [messages, busy, visible]);

  function onScroll() {
    const sc = scrollRef.current;
    if (!sc) return;
    setAtBottom(sc.scrollHeight - sc.scrollTop - sc.clientHeight < 24);
  }
  function scrollToBottom() {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }

  function close() {
    if (onClose) {
      onClose();
      return;
    }
    try {
      window.parent.postMessage({ type: "bleviq-close" }, "*");
    } catch {
      /* ignore */
    }
  }

  async function sendText(q: string) {
    q = q.trim();
    if (!q || busy) return;
    // From the first live send on, use the read-from-top answer scrolling
    // instead of the initial snap-to-bottom.
    initialScrollRef.current = false;
    setInput("");
    // Prior turns (minus the opening greeting) so follow-ups keep context.
    const history = messages
      .slice(1)
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: "user", content: q }]);
    setBusy(true);
    // First message: mint the conversation id now (not at load). This is the
    // first time anything is written to the visitor's device, and it happens
    // on their own action.
    if (!convoIdRef.current) convoIdRef.current = makeConvoId();
    // Roll the resume window forward so an active chat keeps surviving reloads.
    try {
      localStorage.setItem(
        "bv_convo_" + widgetKey,
        JSON.stringify({ id: convoIdRef.current, ts: Date.now() })
      );
    } catch {
      /* ignore */
    }
    try {
      const res = await fetch("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          widgetKey,
          question: q,
          hp,
          history,
          conversationId: convoIdRef.current,
          lang,
          leadCaptured,
        }),
      });
      const data = await res.json();
      const reply =
        data.answer || data.error || "Sorry, something went wrong. Please try again.";
      const suggestions = Array.isArray(data.suggestions)
        ? (data.suggestions as unknown[]).filter(
            (s): s is string => typeof s === "string" && s.trim().length > 0
          )
        : undefined;
      const collectInfo = data.collectInfo === true && !leadCaptured;
      setMessages((m) => [
        ...m,
        { role: "assistant", content: reply, suggestions, collectInfo },
      ]);
    } catch {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: "Network error. Please try again." },
      ]);
    } finally {
      setBusy(false);
    }
  }

  function send() {
    sendText(input);
  }

  // A question typed in the launcher's chat bar is handed in via prop.
  const sendRef = useRef(sendText);
  sendRef.current = sendText;
  useEffect(() => {
    if (pendingQuestion) {
      sendRef.current(pendingQuestion);
      onQuestionConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingQuestion]);

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div
      dir={dir}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        borderRadius: radius || 0,
        overflow: "hidden",
        background: "transparent",
        color: config.textColor,
        fontFamily: font,
      }}
    >
      {/* Header */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "14px 16px",
          background: headerBg,
          borderTopLeftRadius: radius || 0,
          borderTopRightRadius: radius || 0,
        }}
      >
        <Avatar config={config} size={36} />
        <span
          style={{
            flex: 1,
            fontSize: 17,
            fontWeight: 700,
            color: headerFg,
            letterSpacing: "-0.01em",
          }}
        >
          {config.assistantName}
        </span>
        <button
          onClick={close}
          aria-label="Close chat"
          style={{
            border: "none",
            background: "transparent",
            color: headerFg,
            cursor: "pointer",
            opacity: 0.85,
            padding: 4,
            display: "grid",
            placeItems: "center",
            borderRadius: 8,
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      {/* Body carries the chat background, so the header owns the top corners
          and no light layer bleeds behind it. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          background: config.backgroundColor,
          borderBottomLeftRadius: radius || 0,
          borderBottomRightRadius: radius || 0,
        }}
      >
        {/* Messages */}
        <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} ref={i === messages.length - 1 ? lastMsgRef : undefined} style={{ display: "flex", justifyContent: "flex-end", animation: "bvFade .35s ease both" }}>
              <div
                style={{
                  maxWidth: "82%",
                  overflowWrap: "anywhere",
                  borderRadius: 18,
                  ...(rtl
                    ? { borderBottomLeftRadius: 6 }
                    : { borderBottomRightRadius: 6 }),
                  padding: "9px 13px",
                  fontSize: 16,
                  lineHeight: 1.45,
                  background: config.userBubbleColor,
                  color: "#fff",
                }}
              >
                {m.content}
              </div>
            </div>
          ) : (
            <div key={i} ref={i === messages.length - 1 ? lastMsgRef : undefined} style={{ display: "flex", alignItems: "flex-start", gap: 8, animation: "bvFade .35s ease both" }}>
              <Avatar config={config} size={26} />
              <div style={{ maxWidth: "82%", display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                <div
                  style={{
                    maxWidth: "100%",
                    overflowWrap: "anywhere",
                    borderRadius: 18,
                    ...(rtl
                      ? { borderBottomRightRadius: 6 }
                      : { borderBottomLeftRadius: 6 }),
                    padding: "9px 13px",
                    fontSize: 16,
                    lineHeight: 1.45,
                    background: config.assistantBubbleColor,
                    color: config.textColor,
                  }}
                >
                  <MessageContent text={m.content} config={config} />
                </div>
                {m.suggestions && m.suggestions.length > 0 && (
                  <SuggestionChips
                    items={m.suggestions}
                    config={config}
                    disabled={busy}
                    rtl={rtl}
                    onPick={(q) => sendText(q)}
                  />
                )}
                {m.collectInfo && i === messages.length - 1 && (
                  <LeadForm
                    widgetKey={widgetKey}
                    conversationId={convoIdRef.current}
                    contextMessage={
                      i > 0 && messages[i - 1]?.role === "user"
                        ? messages[i - 1].content
                        : ""
                    }
                    labels={labels}
                    config={config}
                    font={font}
                    onCaptured={() => setLeadCaptured(true)}
                  />
                )}
              </div>
            </div>
          )
        )}
        {busy && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <Avatar config={config} size={26} />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                borderRadius: 18,
                ...(rtl
                  ? { borderBottomRightRadius: 6 }
                  : { borderBottomLeftRadius: 6 }),
                padding: "10px 14px",
                background: config.assistantBubbleColor,
              }}
            >
              <span style={{ display: "inline-flex", gap: 3 }}>
                {[0, 1, 2].map((d) => (
                  <span
                    key={d}
                    style={{
                      height: 5,
                      width: 5,
                      borderRadius: "50%",
                      background: config.textColor,
                      opacity: 0.5,
                      animation: "bvBounce 1s ease-in-out infinite",
                      animationDelay: d * 0.16 + "s",
                    }}
                  />
                ))}
              </span>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: config.textColor,
                  opacity: 0.7,
                  whiteSpace: "nowrap",
                }}
              >
                {labels.thinking}
              </span>
            </div>
          </div>
        )}
        </div>

        {!atBottom && (
          <button
            onClick={scrollToBottom}
            aria-label="Scroll to latest"
            style={{
              position: "absolute",
              bottom: 12,
              insetInlineEnd: 12,
              width: 34,
              height: 34,
              borderRadius: "50%",
              border: "1px solid rgba(0,0,0,.08)",
              background: "#fff",
              color: "#334155",
              cursor: "pointer",
              display: "grid",
              placeItems: "center",
              boxShadow: "0 4px 12px rgba(0,0,0,.16)",
              animation: "bvFade .2s ease both",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        )}
        </div>

      {/* Input */}
      <div style={{ padding: "10px 14px 6px" }}>
        <input
          type="text"
          value={hp}
          onChange={(e) => setHp(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          style={{ position: "absolute", left: -9999, width: 1, height: 1 }}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "#f1f5f9",
            borderRadius: 9999,
            paddingBlock: 6,
            paddingInlineStart: 16,
            paddingInlineEnd: 6,
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={labels.placeholder}
            maxLength={FIELD_LIMITS.chatMessage}
            style={{
              flex: 1,
              border: "none",
              background: "transparent",
              outline: "none",
              fontSize: 16,
              color: "#0f172a",
              fontFamily: font,
            }}
          />
          <button
            onClick={send}
            disabled={busy}
            aria-label={labels.send}
            style={{
              height: 36,
              width: 36,
              flexShrink: 0,
              borderRadius: "50%",
              border: "none",
              background: config.bubbleColor,
              color: "#fff",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
              display: "grid",
              placeItems: "center",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          padding: "6px 16px 10px",
          fontSize: 11,
          color: panelIsDark ? "rgba(255,255,255,0.6)" : "#64748b",
        }}
      >
        <p style={{ margin: 0, fontSize: 10, lineHeight: 1.45, textAlign: "center" }}>
          You&rsquo;re chatting with an AI. Messages may be stored. Please
          don&rsquo;t share sensitive personal information. By continuing, you
          agree to our{" "}
          <a
            href="https://www.bleviq.com/ai-terms"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "inherit", textDecoration: "underline" }}
          >
            AI Terms
          </a>
          .
        </p>
        {config.showBranding && (
          <span
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 2,
              marginTop: 5,
            }}
          >
            <span style={{ fontSize: 12 }}>{labels.poweredBy}</span>
            <a
              href="https://bleviq.com"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Bleviq"
              style={{ display: "inline-flex", lineHeight: 0 }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={panelIsDark ? "/logowhite-small.png" : "/logoblack-small.png"}
                alt="Bleviq"
                style={{ height: 20, width: "auto" }}
              />
            </a>
          </span>
        )}
      </div>
      </div>

      <style>{`@keyframes bvBlink{0%,80%,100%{opacity:.25}40%{opacity:.9}}@keyframes bvBounce{0%,80%,100%{transform:translateY(0);opacity:.4}40%{transform:translateY(-5px);opacity:.95}}@keyframes bvFade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}`}</style>
    </div>
  );
}
