import { initialsOf } from "../lib/names.ts";

// What a login answers before the app's own pages: a small page of its own, or JSON for the page's
// server functions and any change. The page has the app's look without its shell: it links the
// kit's stylesheet (`AppContext.stylesheet`) and is written against its tokens.

/** Whether `request` wants JSON: the page's server functions and any change (not a GET or HEAD). */
export const wantsJson = (request: Request) =>
  new URL(request.url).pathname.startsWith("/_serverFn/") || (request.method !== "GET" && request.method !== "HEAD");

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A company as a page names it: its app's name humanised, and two initials for its mark. */
export interface Company {
  name: string;
  initials: string;
}

/**
 * The company an app's name (`package.json`'s, `resolved.appName`) is, for people to read: its
 * scope dropped, `-` and `_` as spaces, each word capitalised (`sanoma-ops` is "Sanoma Ops", "SO").
 */
export function companyOf(appName: string): Company {
  const words = appName
    .replace(/^@[^/]*\//, "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1));
  const name = words.join(" ") || "Sanoma";
  return { name, initials: initialsOf(name) };
}

/** What a small page shows around its card: the kit's stylesheet, the company and a line under the card. */
export interface PageFrame {
  /** The built kit's stylesheet's path (`AppContext.stylesheet`); without one the page's fallback tokens keep it legible. */
  stylesheet?: string;
  company?: Company;
  /** HTML under the card. */
  footer?: string;
}

/** A small page of its own, `body` as HTML in its card: the app's pages are for people signed in. */
export function smallPage(status: number, title: string, body: string, frame: PageFrame = {}): Response {
  const { stylesheet, company, footer } = frame;
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} · ${escapeHtml(company?.name ?? "Sanoma")}</title>` +
    // No icon of its own: without one the browser asks for /favicon.ico, which is behind the login.
    `<link rel="icon" href="data:,"><script>${THEME_SCRIPT}</script><style>${PAGE_STYLE}</style>` +
    (stylesheet ? `<link rel="stylesheet" href="${escapeHtml(stylesheet)}">` : "") +
    `</head><body><main>` +
    (company
      ? `<div class="company"><span class="mark" aria-hidden="true">${escapeHtml(company.initials)}</span>` +
        `<span>${escapeHtml(company.name)}</span></div>`
      : "") +
    `<section class="card">${body}</section>${footer ? `<p class="foot">${footer}</p>` : ""}</main></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * The app's theme, before the page paints: `dark` or `light` on <html> from what the app keeps
 * in this browser (next-themes' `storageKey`, `sanoma.theme`, in `routes/__root.tsx`), else the
 * system's, as its ThemeProvider sets it.
 */
const THEME_SCRIPT =
  `try{const t=localStorage.getItem("sanoma.theme")||"system";` +
  `const dark=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);` +
  `document.documentElement.classList.add(dark?"dark":"light")}catch{}`;

/**
 * The page's own rules, over the kit's tokens (ui.css). The tokens' fallbacks are a layer declared
 * before the stylesheet's, so its `theme` layer wins wherever it loads; without it (an unbuilt dev
 * server) they are the kit's light and dark values. The rest is unlayered, so it wins over
 * Tailwind's preflight.
 */
const PAGE_STYLE = `@layer fallback{:root{color-scheme:light;--radius:.5rem;--background:oklch(.975 .006 153.8);--foreground:oklch(.219 .011 163.8);--card:oklch(.995 .003 145.6);--primary:oklch(.49 .08 176.5);--primary-foreground:oklch(1 0 0);--secondary:oklch(.931 .009 150.7);--muted-foreground:oklch(.5 .015 164.4);--destructive:oklch(.518 .163 27.5);--border:oklch(.895 .009 150.7);--tone-off:oklch(.95 0 0);--tone-off-foreground:oklch(.48 0 0)}
.dark{color-scheme:dark;--background:oklch(.173 .006 156.5);--foreground:oklch(.941 .009 145.5);--card:oklch(.216 .01 159.2);--primary:oklch(.7 .101 175.1);--primary-foreground:oklch(.205 .018 177);--secondary:oklch(.261 .011 156.3);--muted-foreground:oklch(.72 .012 158.7);--destructive:oklch(.741 .123 25.3);--border:oklch(.299 .009 159.5);--tone-off:oklch(.28 0 0);--tone-off-foreground:oklch(.78 0 0)}}
*{box-sizing:border-box}
body{margin:0;background:var(--background);color:var(--foreground);font:14px/1.5 "IBM Plex Sans Variable",system-ui,sans-serif}
main{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:48px 16px}
.company{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:500;color:var(--muted-foreground)}
.mark{width:24px;height:24px;border-radius:calc(var(--radius)*.8);background:var(--primary);color:var(--primary-foreground);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600}
.card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--border);border-radius:calc(var(--radius)*1.4);padding:32px;display:flex;flex-direction:column;gap:20px}
.card[hidden],.card [hidden]{display:none}
h1{margin:0;font:600 26px/1.2 "Fraunces Variable",Georgia,serif}
p{margin:0}
.lede{display:flex;flex-direction:column;gap:6px}
.step{display:flex;flex-direction:column;gap:20px}
.note{display:flex;align-items:center;gap:8px}
.muted,.lede p,.foot{color:var(--muted-foreground)}
.foot,.small{font-size:12px}
code{font:12px "IBM Plex Mono",ui-monospace,monospace}
a{color:var(--primary);text-underline-offset:3px}
form{display:flex;flex-direction:column;gap:12px}
label{display:flex;flex-direction:column;gap:6px;font-size:12px;font-weight:500}
input{height:36px;border:1px solid var(--border);border-radius:calc(var(--radius)*.8);padding:0 10px;font:inherit;font-size:14px;color:var(--foreground);background:var(--card)}
input,.button,.link{outline:0}
input:focus-visible,.button:focus-visible,.link:focus-visible{outline:2px solid var(--primary);outline-offset:1px}
input.code{height:48px;text-align:center;font:500 22px "IBM Plex Mono",ui-monospace,monospace;letter-spacing:.5em;padding-left:.5em}
.button{height:36px;display:flex;align-items:center;justify-content:center;gap:8px;border:1px solid transparent;border-radius:calc(var(--radius)*.8);background:var(--primary);color:var(--primary-foreground);font:inherit;font-size:13px;font-weight:500;text-decoration:none;cursor:pointer}
.button.outline{background:var(--card);color:var(--foreground);border-color:var(--border)}
.button.tall{height:40px}
.button:disabled{opacity:.6;cursor:default}
.or{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--muted-foreground)}
.or::before,.or::after{content:"";flex:1;height:1px;background:var(--border)}
.links{display:flex;justify-content:space-between;gap:12px;font-size:13px}
.link{border:0;background:none;padding:0;font:inherit;color:var(--primary);cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.badge{align-self:flex-start;display:flex;align-items:center;gap:6px;height:22px;padding:0 10px;border-radius:999px;background:var(--tone-off);color:var(--tone-off-foreground);font-size:12px;font-weight:500}
.badge::before{content:"";width:6px;height:6px;border-radius:999px;background:currentColor}
.faces{display:flex}
.face{width:40px;height:40px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;border:2px solid var(--card);background:var(--secondary);color:var(--foreground)}
.face:first-child{background:var(--primary);color:var(--primary-foreground)}
.face+.face{margin-left:-10px}
.rule{padding-top:16px;border-top:1px solid var(--border);font-size:13px;color:var(--muted-foreground)}
.message{font-size:13px;color:var(--destructive)}
.message:empty{display:none}`;
