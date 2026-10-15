// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function plural(n: number, one: string, many: string): string {
  return `${fmt(n)} ${n === 1 ? one : many}`;
}

// A count that opens a sentence: "Two people", "12 people".
export function opening(n: number, one: string, many: string): string {
  const word = WORDS[n];
  return `${word ?? fmt(n)} ${n === 1 ? one : many}`;
}

export function lower(n: number, one: string, many: string): string {
  const word = WORDS[n];
  return `${word && n > 0 ? word.toLowerCase() : fmt(n)} ${n === 1 ? one : many}`;
}

export function listOf(items: readonly string[], max = 4): string {
  if (items.length === 0) return "";
  const shown =
    items.length > max
      ? [...items.slice(0, max - 1), `${items.length - max + 1} more`]
      : [...items];
  if (shown.length === 1) return shown[0] as string;
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

// "1 Oct", or "1 Oct 2025" outside the current year.
export function dayText(iso: string | undefined, now: Date): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === now.getUTCFullYear() ? base : `${base} ${d.getUTCFullYear()}`;
}

export function clockText(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;
}

// "14:05Z" today, "26 Sep 14:05Z" on another day.
export function stampText(iso: string | undefined, now: Date): string | undefined {
  const clock = clockText(iso);
  if (!iso || !clock) return undefined;
  return iso.slice(0, 10) === now.toISOString().slice(0, 10)
    ? clock
    : `${dayText(iso, now)} ${clock}`;
}

// "40 min", "3 h", "6 days".
export function ageText(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 2 * DAY_MS) return `${Math.round(ms / HOUR_MS)} h`;
  return `${Math.floor(ms / DAY_MS)} days`;
}

export function limitText(ms: number): string {
  return ms >= DAY_MS ? `${Math.round(ms / HOUR_MS)} h` : `${Math.round(ms / HOUR_MS)} h`;
}

export function daysText(days: number): string {
  return days <= 0 ? "today" : days === 1 ? "1 d ago" : `${days} d ago`;
}
