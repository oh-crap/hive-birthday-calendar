import React, { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { CalendarDays, Download, Loader2, RefreshCcw, Search, Users, Cake, Activity } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  UI primitives                                                      */
/* ------------------------------------------------------------------ */

function Button({ className = "", variant, ...props }) {
  const base =
    "inline-flex items-center justify-center rounded-xl px-4 py-2 text-sm font-semibold tracking-tight transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#E31337]/60";
  const styles =
    variant === "outline"
      ? "border border-white/15 bg-white/5 text-zinc-100 hover:bg-white/10 hover:border-white/25 backdrop-blur"
      : "bg-[#E31337] text-white shadow-[0_8px_24px_-8px_rgba(227,19,55,0.7)] hover:bg-[#ff2a4d] hover:shadow-[0_10px_30px_-8px_rgba(227,19,55,0.85)] active:translate-y-px";
  return <button className={`${base} ${styles} ${className}`} {...props} />;
}

function Card({ className = "", ...props }) {
  return (
    <div
      className={`rounded-2xl border border-white/10 bg-white/[0.035] shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_20px_50px_-30px_rgba(0,0,0,0.8)] backdrop-blur-xl ${className}`}
      {...props}
    />
  );
}

function CardContent({ className = "", ...props }) {
  return <div className={`p-5 ${className}`} {...props} />;
}

/* ------------------------------------------------------------------ */
/*  Hive RPC config                                                    */
/* ------------------------------------------------------------------ */

const HIVE_NODES = [
  "https://api.hive.blog",
  "https://api.openhive.network",
  "https://rpc.ausbit.dev",
  "https://api.deathwing.me",
];

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

let rpcId = 1; // small incremental integer id — fixes the deserialize error

function normalizeAccountName(value) {
  return (value || "").trim().toLowerCase().replace(/^@/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatFullDate(dateString) {
  if (!dateString) return "—";
  const date = new Date(dateString.endsWith("Z") ? dateString : `${dateString}Z`);
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function dayMonthKey(dateString) {
  const date = new Date(dateString.endsWith("Z") ? dateString : `${dateString}Z`);
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function datePartsUTC(dateString) {
  const date = new Date(dateString.endsWith("Z") ? dateString : `${dateString}Z`);
  return {
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    year: date.getUTCFullYear(),
  };
}

async function rpcCall(node, method, params) {
  const response = await fetch(node, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++, // small integer, not Date.now()
      method,
      params,
    }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = response.statusText;
    }
    throw new Error(`HTTP ${response.status} from ${node}: ${detail}`);
  }

  const data = await response.json();
  if (data.error) {
    const msg = data.error.message || JSON.stringify(data.error);
    throw new Error(`RPC error from ${node}: ${msg}`);
  }
  return data.result;
}

async function rpcCallWithFallback(method, params, preferredNode) {
  const nodes = [preferredNode, ...HIVE_NODES.filter((node) => node !== preferredNode)].filter(Boolean);
  let lastError;

  for (const node of nodes) {
    try {
      const result = await rpcCall(node, method, params);
      return { result, node };
    } catch (error) {
      lastError = error;
      await sleep(150);
    }
  }

  throw lastError || new Error("Could not connect to any Hive RPC node.");
}

async function getFollowing(account, preferredNode, onProgress) {
  const following = [];
  let start = "";
  let activeNode = preferredNode;
  const limit = 100;

  while (true) {
    // params: [account, start, follow_type, limit]
    // start MUST be a string ("" for the first page), never null on strict nodes.
    const { result, node } = await rpcCallWithFallback(
      "condenser_api.get_following",
      [account, start, "blog", limit],
      activeNode
    );
    activeNode = node;

    const batch = Array.isArray(result) ? result : [];
    if (batch.length === 0) break;

    const newItems = batch
      .map((item) => item.following)
      .filter(Boolean);

    following.push(...newItems);
    onProgress?.(`Followed accounts loaded: ${new Set(following).size}`);

    if (batch.length < limit) break;

    const nextStart = batch[batch.length - 1]?.following;
    if (!nextStart || nextStart === start) break;
    start = nextStart;
  }

  // Deduplicate. When paginating with `start`, the last item of one page
  // is repeated as the first of the next — the Set handles that.
  return { following: [...new Set(following)], node: activeNode };
}

async function getAccounts(accounts, preferredNode, onProgress) {
  const all = [];
  let activeNode = preferredNode;
  const chunkSize = 100;

  for (let i = 0; i < accounts.length; i += chunkSize) {
    const chunk = accounts.slice(i, i + chunkSize);
    const { result, node } = await rpcCallWithFallback(
      "condenser_api.get_accounts",
      [chunk],
      activeNode
    );
    activeNode = node;
    all.push(...(Array.isArray(result) ? result : []));
    onProgress?.(`Loading registration dates: ${Math.min(i + chunkSize, accounts.length)} / ${accounts.length}`);
  }

  return { accounts: all, node: activeNode };
}

function buildIcs(events, sourceAccount) {
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Hive Birthday Calendar//EN//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:Hive birthdays for accounts followed by @${sourceAccount}`,
  ];

  for (const event of events) {
    const month = String(event.month + 1).padStart(2, "0");
    const day = String(event.day).padStart(2, "0");
    lines.push(
      "BEGIN:VEVENT",
      `UID:hive-birthday-${event.name}@hive-birthday-calendar`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:2026${month}${day}`,
      "RRULE:FREQ=YEARLY",
      `SUMMARY:Hive birthday @${event.name}`,
      `DESCRIPTION:@${event.name} registered on Hive on ${formatFullDate(event.created)}.`,
      "END:VEVENT"
    );
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function downloadText(filename, text, type = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function HiveBirthdayCalendar() {
  const [account, setAccount] = useState("hiveio");
  const [node, setNode] = useState(HIVE_NODES[0]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("Enter a Hive account and load the users it follows.");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  const grouped = useMemo(() => {
    const filtered = events.filter((event) => event.name.includes(normalizeAccountName(query)));
    return MONTHS.map((month, index) => ({
      month,
      events: filtered
        .filter((event) => event.month === index)
        .sort((a, b) => a.day - b.day || a.name.localeCompare(b.name)),
    }));
  }, [events, query]);

  const nextBirthdays = useMemo(() => {
    const today = new Date();
    const currentKey = `${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
    return [...events]
      .sort((a, b) => {
        const aKey = dayMonthKey(a.created);
        const bKey = dayMonthKey(b.created);
        const normalizedA = aKey >= currentKey ? `0-${aKey}` : `1-${aKey}`;
        const normalizedB = bKey >= currentKey ? `0-${bKey}` : `1-${bKey}`;
        return normalizedA.localeCompare(normalizedB);
      })
      .slice(0, 6);
  }, [events]);

  async function loadData() {
    const sourceAccount = normalizeAccountName(account);
    if (!sourceAccount) {
      setError("Please enter a Hive account first.");
      return;
    }

    setLoading(true);
    setError("");
    setEvents([]);

    try {
      setStatus(`Loading the list of accounts followed by @${sourceAccount}…`);
      const followingResult = await getFollowing(sourceAccount, node, setStatus);
      setNode(followingResult.node);

      if (followingResult.following.length === 0) {
        setStatus(`@${sourceAccount} does not follow anyone, or the following list could not be loaded.`);
        return;
      }

      const accountsResult = await getAccounts(followingResult.following, followingResult.node, setStatus);
      setNode(accountsResult.node);

      const birthdayEvents = accountsResult.accounts
        .filter((item) => item.name && item.created)
        .map((item) => ({
          name: item.name,
          created: item.created,
          ...datePartsUTC(item.created),
        }))
        .sort((a, b) => a.month - b.month || a.day - b.day || a.name.localeCompare(b.name));

      setEvents(birthdayEvents);
      setStatus(`Done: ${birthdayEvents.length} Hive birthdays from accounts followed by @${sourceAccount}. Active RPC node: ${accountsResult.node}`);
    } catch (err) {
      setError(err.message || "An unexpected error occurred.");
      setStatus("Loading failed.");
    } finally {
      setLoading(false);
    }
  }

  function exportIcs() {
    const sourceAccount = normalizeAccountName(account);
    const ics = buildIcs(events, sourceAccount);
    downloadText(`hive-birthdays-${sourceAccount || "account"}.ics`, ics, "text/calendar;charset=utf-8");
  }

  function exportJson() {
    const sourceAccount = normalizeAccountName(account);
    downloadText(
      `hive-birthdays-${sourceAccount || "account"}.json`,
      JSON.stringify({ sourceAccount, generatedAt: new Date().toISOString(), events }, null, 2),
      "application/json;charset=utf-8"
    );
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#0a0608] text-zinc-100 antialiased">
      {/* Ambient background */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 -left-40 h-[34rem] w-[34rem] rounded-full bg-[#E31337]/20 blur-[140px]" />
        <div className="absolute top-1/3 -right-40 h-[30rem] w-[30rem] rounded-full bg-[#7a0a1c]/25 blur-[150px]" />
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
          }}
        />
      </div>

      <div className="relative mx-auto max-w-7xl space-y-6 p-4 md:p-8">
        {/* Header */}
        <motion.header
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-white/[0.06] to-transparent p-7 backdrop-blur-xl md:p-10"
        >
          <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#E31337]/30 bg-[#E31337]/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[#ff5d72]">
                <Cake className="h-3.5 w-3.5" /> Hive Blockchain
              </div>
              <h1 className="text-4xl font-black leading-[0.95] tracking-tight md:text-6xl">
                Hive Birthday
                <span className="block bg-gradient-to-r from-[#E31337] to-[#ff7a5a] bg-clip-text text-transparent">
                  Calendar
                </span>
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-relaxed text-zinc-400 md:text-base">
                Enter an account and the app scans the profiles it follows, loads their Hive
                registration dates, and lays out those anniversaries in a clean calendar view.
              </p>
            </div>
            <div className="inline-flex shrink-0 items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-xs font-medium text-zinc-400">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              GitHub Pages ready
            </div>
          </div>
        </motion.header>

        {/* Controls */}
        <Card>
          <CardContent className="p-5 md:p-6">
            <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr_auto] lg:items-end">
              <label className="space-y-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Hive account</span>
                <div className="flex items-center rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 transition focus-within:border-[#E31337]/50 focus-within:ring-2 focus-within:ring-[#E31337]/30">
                  <span className="text-zinc-500">@</span>
                  <input
                    value={account}
                    onChange={(event) => setAccount(event.target.value)}
                    placeholder="e.g. hiveio"
                    className="w-full bg-transparent px-1 text-zinc-100 placeholder-zinc-600 outline-none"
                    onKeyDown={(event) => event.key === "Enter" && loadData()}
                  />
                </div>
              </label>

              <label className="space-y-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">RPC node</span>
                <select
                  value={node}
                  onChange={(event) => setNode(event.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-zinc-100 outline-none transition focus:border-[#E31337]/50 focus:ring-2 focus:ring-[#E31337]/30"
                >
                  {HIVE_NODES.map((item) => (
                    <option key={item} value={item} className="bg-[#0a0608]">{item}</option>
                  ))}
                </select>
              </label>

              <Button onClick={loadData} disabled={loading} className="h-[46px] px-7">
                {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCcw className="mr-2 h-4 w-4" />}
                Load calendar
              </Button>
            </div>

            <div className="mt-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <p className="flex items-center gap-2 text-sm text-zinc-400">
                <Activity className="h-3.5 w-3.5 shrink-0 text-[#ff5d72]" />
                <span className="break-all">{status}</span>
              </p>
              {events.length > 0 && (
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button variant="outline" onClick={exportIcs}>
                    <Download className="mr-2 h-4 w-4" /> Export .ics
                  </Button>
                  <Button variant="outline" onClick={exportJson}>
                    <Download className="mr-2 h-4 w-4" /> Export JSON
                  </Button>
                </div>
              )}
            </div>
            {error && (
              <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
                {error}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Results */}
        {events.length > 0 && (
          <section className="grid gap-6 lg:grid-cols-[360px_1fr]">
            <div className="space-y-6">
              <Card>
                <CardContent className="p-5">
                  <div className="flex items-center gap-4">
                    <div className="rounded-2xl bg-[#E31337]/15 p-3.5 text-[#ff5d72] ring-1 ring-[#E31337]/30">
                      <Users className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wider text-zinc-500">Profiles loaded</p>
                      <p className="text-3xl font-black tabular-nums">{events.length}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-5">
                  <h2 className="flex items-center gap-2 text-base font-bold">
                    <Cake className="h-4 w-4 text-[#ff5d72]" /> Upcoming Hive birthdays
                  </h2>
                  <div className="mt-4 space-y-2.5">
                    {nextBirthdays.map((event) => (
                      <div
                        key={event.name}
                        className="rounded-xl border border-white/5 bg-black/20 p-3 transition hover:border-[#E31337]/30 hover:bg-[#E31337]/[0.06]"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <a
                            className="font-semibold text-[#ff5d72] hover:underline"
                            href={`https://hive.blog/@${event.name}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            @{event.name}
                          </a>
                          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium tabular-nums text-zinc-300">
                            {MONTHS[event.month]} {event.day}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-zinc-500">Registered: {formatFullDate(event.created)}</p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="space-y-4">
              <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.035] p-2.5 backdrop-blur-xl">
                <Search className="ml-2 h-4 w-4 text-zinc-500" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter by username…"
                  className="w-full bg-transparent p-1.5 text-zinc-100 placeholder-zinc-600 outline-none"
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {grouped.map(({ month, events: monthEvents }) => (
                  <Card key={month} className="transition hover:border-white/20">
                    <CardContent className="p-5">
                      <div className="mb-4 flex items-center justify-between">
                        <h2 className="text-lg font-bold tracking-tight">{month}</h2>
                        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-xs font-semibold tabular-nums text-zinc-400">
                          {monthEvents.length}
                        </span>
                      </div>
                      {monthEvents.length === 0 ? (
                        <p className="text-sm text-zinc-600">No entries</p>
                      ) : (
                        <div className="space-y-2">
                          {monthEvents.map((event) => (
                            <div
                              key={event.name}
                              className="rounded-xl border border-white/5 bg-black/20 p-3 transition hover:border-[#E31337]/30 hover:bg-[#E31337]/[0.06]"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <a
                                  className="font-semibold text-zinc-100 transition hover:text-[#ff5d72] hover:underline"
                                  href={`https://hive.blog/@${event.name}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  @{event.name}
                                </a>
                                <span className="text-sm font-black tabular-nums text-[#ff5d72]">{event.day}</span>
                              </div>
                              <p className="mt-1 text-xs text-zinc-500">
                                Since {event.year} • {formatFullDate(event.created)}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
