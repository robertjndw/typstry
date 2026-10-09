import { useSyncExternalStore } from "react";

import { getStorage, readJson, writeJson } from "@/lib/storage";

export interface Identity {
  name: string;
  color: string;
}

export const IDENTITY_KEY = "typstry:identity";
export const MAX_NAME_LENGTH = 40;

/**
 * Dark enough for white initials (WCAG AA against #fff) and distinct enough
 * from each other to tell carets apart.
 */
export const PALETTE = [
  "#c2410c", // orange
  "#b91c1c", // red
  "#be185d", // pink
  "#7e22ce", // purple
  "#4338ca", // indigo
  "#1d4ed8", // blue
  "#0e7490", // cyan
  "#047857", // emerald
  "#4d7c0f", // lime
  "#a16207", // amber
] as const;

const ADJECTIVES = [
  "Amber",
  "Brave",
  "Calm",
  "Clever",
  "Curious",
  "Gentle",
  "Happy",
  "Lucky",
  "Merry",
  "Nimble",
  "Quiet",
  "Swift",
  "Sunny",
  "Witty",
];

const ANIMALS = [
  "Badger",
  "Falcon",
  "Fox",
  "Heron",
  "Koala",
  "Lynx",
  "Otter",
  "Owl",
  "Panda",
  "Puffin",
  "Raccoon",
  "Seal",
  "Tiger",
  "Wombat",
];

/**
 * Colors end up in inline styles of other people's editors, so anything but
 * a plain hex color is rejected rather than passed through.
 */
export function isValidColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH);
}

function pick<T>(list: readonly T[], random: () => number): T {
  return list[Math.floor(random() * list.length) % list.length]!;
}

export function randomIdentity(random: () => number = Math.random): Identity {
  return {
    name: `${pick(ADJECTIVES, random)} ${pick(ANIMALS, random)}`,
    color: pick(PALETTE, random),
  };
}

export function parseIdentity(value: unknown): Identity | null {
  if (typeof value !== "object" || value === null) return null;
  const { name, color } = value as Partial<Identity>;
  if (typeof name !== "string" || !isValidColor(color)) return null;
  const normalized = normalizeName(name);
  return normalized ? { name: normalized, color } : null;
}

export function loadIdentity(
  storage: Storage | null = getStorage(),
): Identity | null {
  return parseIdentity(readJson(IDENTITY_KEY, storage));
}

export function saveIdentity(
  identity: Identity,
  storage: Storage | null = getStorage(),
): void {
  writeJson(IDENTITY_KEY, identity, storage);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1 ? parts[0]![0]! + parts.at(-1)![0]! : (parts[0] ?? "?");
  return letters.slice(0, 2).toUpperCase();
}

// Shared across components (toolbar avatar, name dialog, presence) so an edit
// in one place shows up everywhere without a context provider.
let current: Identity | null | undefined;
const listeners = new Set<() => void>();

function snapshot(): Identity | null {
  if (current === undefined) current = loadIdentity();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Keeps tabs of the same browser in agreement.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== IDENTITY_KEY) return;
    current = loadIdentity();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setIdentity(identity: Identity): void {
  const parsed = parseIdentity(identity);
  if (!parsed) return;
  saveIdentity(parsed);
  current = parsed;
  for (const listener of [...listeners]) listener();
}

/** The stored identity, or null before the user picked one. */
export function useStoredIdentity(): Identity | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/** Test hook: forget the cached identity so the next read hits storage. */
export function resetIdentityCache(): void {
  current = undefined;
}
