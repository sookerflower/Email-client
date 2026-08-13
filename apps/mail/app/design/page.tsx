import { useState } from 'react';

/**
 * /design — the ui-redesign phase-0 showcase. Renders the entire --ax-*
 * token system on one screen so the direction can be judged before any of
 * it touches the app. This page consumes tokens ONLY — a hex value here is
 * a defect. It is intentionally outside the app layouts: no auth, no data.
 */

const swatchGroups: { title: string; items: [string, string][] }[] = [
  {
    title: 'Background ramp',
    items: [
      ['base', 'bg-ax-base'],
      ['surface', 'bg-ax-surface'],
      ['raised', 'bg-ax-raised'],
      ['overlay', 'bg-ax-overlay'],
    ],
  },
  {
    title: 'Interaction states',
    items: [
      ['hover', 'bg-ax-hover'],
      ['active', 'bg-ax-active'],
      ['selected', 'bg-ax-selected'],
      ['accent-muted', 'bg-ax-accent-muted'],
    ],
  },
  {
    title: 'Accent & semantic',
    items: [
      ['accent', 'bg-ax-accent'],
      ['success', 'bg-ax-success'],
      ['warning', 'bg-ax-warning'],
      ['danger', 'bg-ax-danger'],
    ],
  },
];

const typeScale: { name: string; cls: string; sample: string }[] = [
  { name: 'display · 24/32 · 600', cls: 'ax-type-display', sample: 'Inbox zero, finally' },
  { name: 'title · 20/28 · 600', cls: 'ax-type-title', sample: 'Team Meeting Invitation' },
  { name: 'heading · 16/24 · 600', cls: 'ax-type-heading', sample: 'Settings — Connections' },
  { name: 'body · 14/22 · 450', cls: 'ax-type-body', sample: 'Could you confirm your availability for Thursday afternoon?' },
  { name: 'ui · 13/20 · 450 (workhorse)', cls: 'ax-type-ui', sample: 'Move to Archive · Snooze until tomorrow · Reply all' },
  { name: 'small · 12/16 · 450', cls: 'ax-type-small', sample: '24 threads · updated 2 minutes ago' },
  { name: 'micro · 11/14 · 520', cls: 'ax-type-micro uppercase', sample: 'Core · Management · Labels' },
];

const listRows: {
  sender: string;
  subject: string;
  time: string;
  unread?: boolean;
  starred?: boolean;
  selected?: boolean;
}[] = [
  { sender: 'Sooker', subject: 'Re: Team Meeting Invitation - 12-08-2026', time: '11:23', unread: true },
  { sender: 'Ashwin Parthi', subject: 'offer letter', time: 'Jul 1', starred: true },
  { sender: 'A2b R', subject: 'Prompt to explain the code', time: 'Jun 24', selected: true },
  { sender: 'Vishak Anand', subject: 'Test recieve — attachment inside', time: 'Jun 23' },
];

function EasingDemo({ label, ease, dur }: { label: string; ease: string; dur: string }) {
  const [run, setRun] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setRun((v) => !v)}
      className="flex w-full items-center gap-3 rounded-ax-control border border-ax-border bg-ax-raised px-3 py-2 text-left transition-transform duration-[var(--ax-dur-press)] ease-ax-out active:scale-[0.98]"
    >
      <span className="ax-type-small w-40 shrink-0 text-ax-secondary">{label}</span>
      <span className="relative h-2 grow rounded-full bg-ax-active">
        <span
          className="absolute top-1/2 size-3 -translate-y-1/2 rounded-full bg-ax-accent transition-[left]"
          style={{ left: run ? 'calc(100% - 12px)' : '0px', transitionTimingFunction: ease, transitionDuration: dur }}
        />
      </span>
      <span className="ax-type-micro shrink-0 text-ax-tertiary">{dur}</span>
    </button>
  );
}

function PopoverDemo() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="ax-type-ui h-8 rounded-ax-control border border-ax-border bg-ax-raised px-3 font-[var(--ax-weight-medium)] text-ax-primary transition-[background-color,transform] duration-[var(--ax-dur-press)] ease-ax-out hover:bg-ax-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ax-ring active:scale-[0.97]"
      >
        {open ? 'Close popover' : 'Open popover'}
      </button>
      {open ? (
        <div className="ax-popover-enter absolute left-0 top-10 z-10 w-56 origin-top-left rounded-ax-surface bg-ax-overlay p-1 shadow-ax-popover">
          {['Reply', 'Forward', 'Snooze…', 'Move to Archive'].map((item) => (
            <div
              key={item}
              className="ax-type-ui cursor-default rounded-[calc(var(--ax-radius-surface)-4px)] px-2 py-1.5 text-ax-primary hover:bg-ax-hover"
            >
              {item}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function DesignShowcase() {
  const [dark, setDark] = useState(true);
  return (
    <div className={dark ? 'dark' : ''}>
      {/* Type utilities moved to globals.css in phase 1; only the demo-local
          entrance rules remain here. */}
      <style>{`
        .ax-popover-enter { transition: transform var(--ax-dur-base) var(--ax-ease-out), opacity var(--ax-dur-base) var(--ax-ease-out); }
        @starting-style { .ax-popover-enter { opacity: 0; transform: scale(0.97); } }
        .ax-empty-enter { transition: transform var(--ax-dur-slow) var(--ax-ease-out), opacity var(--ax-dur-slow) var(--ax-ease-out); }
        @starting-style { .ax-empty-enter { opacity: 0; transform: translateY(8px); } }
      `}</style>

      <div className="min-h-screen bg-ax-base font-sans text-ax-primary antialiased">
        <div className="mx-auto max-w-4xl px-8 py-12">
          {/* Header */}
          <div className="mb-12 flex items-start justify-between">
            <div>
              <div className="ax-type-micro mb-2 uppercase text-ax-tertiary">AxMail · ui-redesign · phase 0</div>
              <h1 className="ax-type-display">Design direction</h1>
              <p className="ax-type-body mt-2 max-w-lg text-ax-secondary">
                Dark-first, quiet neutrals on a cool near-black ramp, one restrained blue accent,
                13px UI type, hairline borders carrying elevation, motion under 300ms on strong
                ease-out curves — and none of it on the hot path.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDark((v) => !v)}
              className="ax-type-ui h-8 shrink-0 rounded-ax-control border border-ax-border bg-ax-raised px-3 text-ax-primary transition-transform duration-[var(--ax-dur-press)] ease-ax-out hover:bg-ax-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ax-ring active:scale-[0.97]"
            >
              {dark ? 'View light' : 'View dark'}
            </button>
          </div>

          {/* Colors */}
          <section className="mb-12">
            <h2 className="ax-type-heading mb-4">Color</h2>
            <div className="grid grid-cols-3 gap-6">
              {swatchGroups.map((group) => (
                <div key={group.title}>
                  <div className="ax-type-micro mb-2 uppercase text-ax-tertiary">{group.title}</div>
                  <div className="overflow-hidden rounded-ax-surface border border-ax-border">
                    {group.items.map(([name, cls]) => (
                      <div key={name} className={`${cls} flex h-11 items-center justify-between px-3`}>
                        <span className="ax-type-small text-ax-secondary mix-blend-difference">{name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex gap-6">
              <span className="ax-type-body text-ax-primary">text-primary</span>
              <span className="ax-type-body text-ax-secondary">text-secondary</span>
              <span className="ax-type-body text-ax-tertiary">text-tertiary</span>
              <span className="ax-type-body text-ax-disabled">text-disabled</span>
              <span className="ax-type-body text-ax-accent">accent link</span>
            </div>
          </section>

          {/* Type */}
          <section className="mb-12">
            <h2 className="ax-type-heading mb-4">Type — Geist, tightened</h2>
            <div className="space-y-4 rounded-ax-surface border border-ax-border bg-ax-surface p-6">
              {typeScale.map((t) => (
                <div key={t.name} className="flex items-baseline gap-6">
                  <span className="ax-type-micro w-52 shrink-0 uppercase text-ax-tertiary">{t.name}</span>
                  <span className={t.cls}>{t.sample}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Controls */}
          <section className="mb-12">
            <h2 className="ax-type-heading mb-4">Controls — 32px, 6px radius, press feedback</h2>
            <div className="flex flex-wrap items-center gap-3 rounded-ax-surface border border-ax-border bg-ax-surface p-6">
              <button type="button" className="ax-type-ui h-8 rounded-ax-control bg-ax-accent px-3.5 font-[var(--ax-weight-medium)] text-ax-on-accent transition-[background-color,transform] duration-[var(--ax-dur-press)] ease-ax-out hover:bg-ax-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ax-ring focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ax-bg-surface)] active:scale-[0.97]">
                Send
              </button>
              <button type="button" className="ax-type-ui h-8 rounded-ax-control border border-ax-border bg-ax-raised px-3.5 text-ax-primary transition-[background-color,transform] duration-[var(--ax-dur-press)] ease-ax-out hover:bg-ax-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ax-ring active:scale-[0.97]">
                Save draft
              </button>
              <button type="button" className="ax-type-ui h-8 rounded-ax-control px-3.5 text-ax-secondary transition-[background-color,color,transform] duration-[var(--ax-dur-press)] ease-ax-out hover:bg-ax-hover hover:text-ax-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ax-ring active:scale-[0.97]">
                Discard
              </button>
              <button type="button" className="ax-type-ui h-8 rounded-ax-control bg-ax-danger-muted px-3.5 font-[var(--ax-weight-medium)] text-ax-danger transition-transform duration-[var(--ax-dur-press)] ease-ax-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ax-ring active:scale-[0.97]">
                Delete forever
              </button>
              <span className="ax-type-ui inline-flex h-6 items-center rounded-full bg-ax-accent-muted px-2.5 text-ax-accent">
                label chip
              </span>
              <input
                placeholder="Search mail…"
                className="ax-type-ui h-8 w-56 rounded-ax-control border border-ax-border bg-ax-base px-3 text-ax-primary placeholder:text-ax-tertiary focus-visible:border-ax-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ax-ring"
              />
            </div>
          </section>

          {/* List rows */}
          <section className="mb-12">
            <h2 className="ax-type-heading mb-4">Mail list — 36px rows, no render motion</h2>
            <div className="overflow-hidden rounded-ax-surface border border-ax-border bg-ax-surface">
              {listRows.map((row) => (
                <div
                  key={row.subject}
                  className={`flex h-[var(--ax-row-h)] cursor-default items-center gap-3 border-b border-ax-border-subtle px-4 last:border-b-0 ${
                    row.selected ? 'bg-ax-selected' : 'hover:bg-ax-hover'
                  }`}
                >
                  <span className={`size-1.5 shrink-0 rounded-full ${row.unread ? 'bg-ax-accent' : 'bg-transparent'}`} />
                  <span
                    className={`ax-type-ui w-36 shrink-0 truncate ${row.unread ? 'font-[var(--ax-weight-semibold)] text-ax-primary' : 'text-ax-secondary'}`}
                  >
                    {row.sender}
                  </span>
                  <span className={`ax-type-ui grow truncate ${row.unread ? 'text-ax-primary' : 'text-ax-secondary'}`}>
                    {row.subject}
                  </span>
                  {row.starred ? <span className="shrink-0 text-ax-warning">★</span> : null}
                  <span className="ax-type-small shrink-0 tabular-nums text-ax-tertiary">{row.time}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Elevation + empty state */}
          <section className="mb-12 grid grid-cols-2 gap-6">
            <div>
              <h2 className="ax-type-heading mb-4">Elevation</h2>
              <div className="space-y-4">
                <div className="ax-type-ui rounded-ax-surface bg-ax-raised p-4 shadow-ax-raised">raised — cards, rows</div>
                <div className="ax-type-ui rounded-ax-surface bg-ax-overlay p-4 shadow-ax-popover">popover — menus, dropdowns</div>
                <div className="ax-type-ui rounded-ax-modal bg-ax-overlay p-4 shadow-ax-modal">modal — dialogs, compose</div>
              </div>
            </div>
            <div>
              <h2 className="ax-type-heading mb-4">Empty state — the delight slot</h2>
              <div className="ax-empty-enter flex h-[204px] flex-col items-center justify-center rounded-ax-surface border border-ax-border bg-ax-surface text-center">
                <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-ax-accent-muted text-ax-accent">✓</div>
                <div className="ax-type-body font-[var(--ax-weight-medium)]">You&rsquo;re all caught up</div>
                <div className="ax-type-small mt-1 text-ax-tertiary">New mail lands here the moment it arrives.</div>
              </div>
            </div>
          </section>

          {/* Motion */}
          <section className="mb-12">
            <h2 className="ax-type-heading mb-4">Motion — click a row to run it</h2>
            <div className="space-y-2">
              <EasingDemo label="ease-ax-out · entrances" ease="var(--ax-ease-out)" dur="200ms" />
              <EasingDemo label="ease-ax-in-out · on-screen moves" ease="var(--ax-ease-in-out)" dur="280ms" />
              <EasingDemo label="ease-ax-drawer · sheets" ease="var(--ax-ease-drawer)" dur="280ms" />
            </div>
            <div className="mt-4 flex items-center gap-4">
              <PopoverDemo />
              <span className="ax-type-small text-ax-tertiary">
                popover: scale 0.97 → 1 + fade, 200ms, origin-aware · press: scale 0.97, 120ms · hot
                path (list, keyboard nav): no motion, ever
              </span>
            </div>
          </section>

          <div className="ax-type-small border-t border-ax-border-subtle pt-4 text-ax-tertiary">
            Every value on this page is a token. The AxMail mark, favicon and OG art are untouched
            by the redesign; the chat keeps its green mark.
          </div>
        </div>
      </div>
    </div>
  );
}
