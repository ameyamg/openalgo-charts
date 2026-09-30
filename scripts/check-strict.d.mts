// The types of check-strict.mjs, for tests/strict-tiers.test.ts.
import type ts from 'typescript';

export const TIERS: readonly string[];
export function tierOf(file: string): string | null;
export function strictDiagnostics(configPath: string): ts.Diagnostic[];
export function byTier(diagnostics: readonly ts.Diagnostic[], root: string): {
  tiers: Map<string, ts.Diagnostic[]>;
  untiered: ts.Diagnostic[];
};
export function ratchetProblems(tiers: ReadonlyMap<string, readonly ts.Diagnostic[]>, clean: readonly string[]): string[];
