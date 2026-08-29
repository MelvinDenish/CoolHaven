/**
 * Display formatters, in a module with no client boundary.
 *
 * These lived in components/ui.tsx, which carries 'use client'. That was fine
 * while every consumer was a client component, and stopped being fine the
 * moment a SERVER component - the methodology page - needed to format a cost:
 * React refuses to call a function exported across a client boundary from the
 * server, and the page 500s at render rather than failing at build or
 * typecheck, which is why it took rendering the page to find it.
 *
 * A pure number-to-string function has no business being client-only, so it
 * lives here. ui.tsx re-exports both names, which keeps every existing import
 * working and means neither of them has two implementations to drift apart.
 */

/** Minutes, abbreviated. Under an hour stays a bare count; over it reads "2h 5". */
export function fmtMinutes(m: number): string {
  if (m < 1) return '<1';
  if (m < 60) return `${Math.round(m)}`;
  return `${Math.floor(m / 60)}h ${Math.round(m % 60)}`;
}

/**
 * US dollars at the magnitude a capital plan is argued in.
 *
 * Millions to two decimals, thousands rounded whole - nobody debating a
 * cooling network cares about the last $400 of a $1.8M programme, and the
 * extra digits make a column of costs harder to scan.
 */
export function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1000)}k`;
  return `$${n}`;
}
