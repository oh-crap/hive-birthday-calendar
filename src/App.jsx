
import React, { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { CalendarDays, Download, Loader2, RefreshCcw, Search, Users } from "lucide-react";

function Button({ className = "", variant, ...props }) {
  return (
    <button
      className={`inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60 ${variant === "outline" ? "bg-white text-slate-900 hover:bg-slate-50" : ""} ${className}`}
      {...props}
    />
  );
}

function Card({ className = "", ...props }) {
  return (
    <div
      className={`rounded-3xl border border-slate-200 bg-white shadow-sm ${className}`}
      {...props}
    />
  );
}

function CardContent({ className = "", ...props }) {
  return (
    <div
      className={`p-5 ${className}`}
      {...props}
    />
  );
}

const HIVE_NODES = [
  "https://api.hive.blog",
  "https://api.openhive.network",
  "https://rpc.ausbit.dev",
  "https://api.deathwing.me",
];

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function normalizeAccountName(value) {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
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
      id: Date.now(),
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message || "RPC error");
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
      .filter(Boolean)
      .filter((name) => name !== start);

    following.push(...newItems);
    onProgress?.(`Followed accounts loaded: ${following.length}`);

    if (batch.length < limit) break;
    const nextStart = batch[batch.length - 1]?.following;
    if (!nextStart || nextStart === start) break;
    start = nextStart;
  }

  return { following: [...new Set(following)], node: activeNode };
}

async function getAccounts(accounts, preferredNode, onProgress) {
  const all = [];
  let activeNode = preferredNode;
  const chunkSize = 100;

  for (let i = 0; i < accounts.length; i += chunkSize) {
    const chunk = accounts.slice(i, i + chunkSize);
    const { result, node } = await rpcCallWithFallback("condenser_api.get_accounts", [chunk], activeNode);
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
  return lines.join("\\r\\n");
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
    <main className="min-h-screen bg-slate-50 p-4 text-slate-900 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <motion.header
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-3xl bg-white p-6 shadow-sm md:p-8"
        >
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-800">
                <CalendarDays className="h-4 w-4" /> Hive Birthday Calendar
              </div>
              <h1 className="text-3xl font-bold tracking-tight md:text-5xl">Hive Birthday Calendar</h1>
              <p className="mt-3 max-w-3xl text-base text-slate-600 md:text-lg">
                Enter an account, and the app will scan the profiles it follows, load their Hive registration dates, and display those anniversaries in a clear calendar view.
              </p>
            </div>
            <div className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-600">
              GitHub Pages ready
            </div>
          </div>
        </motion.header>

        <Card className="rounded-3xl border-0 shadow-sm">
          <CardContent className="p-5 md:p-6">
            <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr_auto] lg:items-end">
              <label className="space-y-2">
                <span className="text-sm font-semibold">Hive account</span>
                <div className="flex rounded-2xl border border-slate-200 bg-white px-3 py-2 focus-within:ring-2 focus-within:ring-amber-400">
                  <span className="pt-1 text-slate-400">@</span>
                  <input
                    value={account}
                    onChange={(event) => setAccount(event.target.value)}
                    placeholder="e.g. hiveio"
                    className="w-full bg-transparent px-1 py-1 outline-none"
                    onKeyDown={(event) => event.key === "Enter" && loadData()}
                  />
                </div>
              </label>

              <label className="space-y-2">
                <span className="text-sm font-semibold">RPC node</span>
                <select
                  value={node}
                  onChange={(event) => setNode(event.target.value)}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 outline-none focus:ring-2 focus:ring-amber-400"
                >
                  {HIVE_NODES.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </label>

              <Button onClick={loadData} disabled={loading} className="rounded-2xl px-6 py-6">
                {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCcw className="mr-2 h-4 w-4" />}
                Load calendar
              </Button>
            </div>

            <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <p className="text-sm text-slate-600">{status}</p>
              {events.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={exportIcs} className="rounded-2xl">
                    <Download className="mr-2 h-4 w-4" /> Export .ics
                  </Button>
                  <Button variant="outline" onClick={exportJson} className="rounded-2xl">
                    <Download className="mr-2 h-4 w-4" /> Export JSON
                  </Button>
                </div>
              )}
            </div>
            {error && <p className="mt-3 rounded-2xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          </CardContent>
        </Card>

        {events.length > 0 && (
          <section className="grid gap-6 lg:grid-cols-[360px_1fr]">
            <div className="space-y-6">
              <Card className="rounded-3xl border-0 shadow-sm">
                <CardContent className="p-5">
                  <div className="flex items-center gap-3">
                    <div className="rounded-2xl bg-amber-100 p-3 text-amber-700">
                      <Users className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm text-slate-500">Profiles loaded</p>
                      <p className="text-3xl font-bold">{events.length}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="rounded-3xl border-0 shadow-sm">
                <CardContent className="p-5">
                  <h2 className="text-lg font-bold">Upcoming Hive birthdays</h2>
                  <div className="mt-4 space-y-3">
                    {nextBirthdays.map((event) => (
                      <div key={event.name} className="rounded-2xl bg-slate-50 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <a className="font-semibold text-amber-700 hover:underline" href={`https://hive.blog/@${event.name}`} target="_blank" rel="noreferrer">@{event.name}</a>
                          <span className="rounded-full bg-white px-2 py-1 text-xs font-medium text-slate-600">{MONTHS[event.month]} {event.day}</span>
                        </div>
                        <p className="mt-1 text-sm text-slate-500">Registered: {formatFullDate(event.created)}</p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="space-y-4">
              <div className="flex items-center gap-2 rounded-3xl bg-white p-3 shadow-sm">
                <Search className="ml-2 h-4 w-4 text-slate-400" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter by username…"
                  className="w-full bg-transparent p-2 outline-none"
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {grouped.map(({ month, events: monthEvents }) => (
                  <Card key={month} className="rounded-3xl border-0 shadow-sm">
                    <CardContent className="p-5">
                      <div className="mb-4 flex items-center justify-between">
                        <h2 className="text-xl font-bold">{month}</h2>
                        <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">{monthEvents.length}</span>
                      </div>
                      {monthEvents.length === 0 ? (
                        <p className="text-sm text-slate-400">No entries</p>
                      ) : (
                        <div className="space-y-2">
                          {monthEvents.map((event) => (
                            <div key={event.name} className="rounded-2xl border border-slate-100 p-3 hover:border-amber-200 hover:bg-amber-50/40">
                              <div className="flex items-center justify-between gap-2">
                                <a className="font-semibold text-slate-900 hover:text-amber-700 hover:underline" href={`https://hive.blog/@${event.name}`} target="_blank" rel="noreferrer">@{event.name}</a>
                                <span className="text-sm font-bold text-amber-700">{event.day}</span>
                              </div>
                              <p className="mt-1 text-xs text-slate-500">Since {event.year} • {formatFullDate(event.created)}</p>
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
