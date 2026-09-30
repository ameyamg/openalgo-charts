/**
 * scripts/check-strict.mjs adopts the stricter compiler flags one tier at a
 * time, and its worth is in putting each error in the right tier. Counting by
 * config include would charge every tier with the whole base, so the gate
 * would never pass; losing errors would make it pass for nothing. The fixture
 * in scripts/fixtures/strict compiles through the real tsconfig.strict.json
 * and holds one error of each flag in the profile tier, one in a base
 * directory, and a trade tier with none.
 */
import type ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TIERS, byTier, ratchetProblems, strictDiagnostics, tierOf } from '../scripts/check-strict.mjs';
import list from '../scripts/strict-tiers.json';
import strictConfig from '../tsconfig.strict.json';

// Same root derivation as line-caps.test.ts and deprecation-policy.test.ts:
// the suite carries no Node typings.
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const FIXTURE = `${ROOT}scripts/fixtures/strict/`;

let compiled: ts.Diagnostic[] | undefined;
/** The fixture's errors, compiled once for the whole file. */
const fixtureErrors = (): ts.Diagnostic[] => (compiled ??= strictDiagnostics(`${FIXTURE}tsconfig.json`));

/** Where each error is and its code, as `src/<dir>/<file> TS<code>`. */
const located = (errors: readonly ts.Diagnostic[] | undefined): string[] => (errors ?? [])
  .map((d) => `${d.file?.fileName.slice(d.file.fileName.lastIndexOf('/src/') + 1)} TS${d.code}`)
  .sort();

describe('tsconfig.strict.json', () => {
  it('is the main config with both stricter flags on, over src', () => {
    expect(strictConfig.extends).toBe('./tsconfig.json');
    expect(strictConfig.compilerOptions).toEqual({ noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true });
    expect(strictConfig.include).toEqual(['src']);
  });
});

describe('strict errors by tier', () => {
  it('names each tier from the package entry points and puts every other src file in the base', () => {
    expect([...TIERS].sort()).toEqual(['base', 'draw', 'indicators', 'profile', 'trade', 'transform', 'webgl', 'widget', 'workspace']);
    expect(tierOf('src/profile/tpo.ts')).toBe('profile');
    expect(tierOf('src/webgl/index.ts')).toBe('webgl');
    expect(tierOf('src/render/webgl/backend.ts')).toBe('base');
    expect(tierOf('src/model/data-layer.ts')).toBe('base');
    expect(tierOf('src/index.ts')).toBe('base');
    expect(tierOf('tests/chart.test.ts')).toBeNull();
  });

  it('counts each error against the tier of the file it is in', () => {
    const { tiers, untiered } = byTier(fixtureErrors(), FIXTURE);
    expect(located(tiers.get('profile'))).toEqual(['src/profile/index-read.ts TS2322', 'src/profile/optional-style.ts TS2375']);
    expect(located(tiers.get('base'))).toEqual(['src/model/index-read.ts TS2322']);
    expect(tiers.get('trade')).toEqual([]);
    expect(untiered).toEqual([]);
    expect([...tiers.keys()].sort()).toEqual([...TIERS].sort());
  });

  it('reports the two flags, not the main config', () => {
    const text = fixtureErrors().map((d) => JSON.stringify(d.messageText)).join('\n');
    expect(text).toContain("Type 'number | undefined' is not assignable to type 'number'");
    expect(text).toContain("with 'exactOptionalPropertyTypes: true'");
  });

  it('fails a tier listed as clean that has an error, and passes the rest', () => {
    const { tiers } = byTier(fixtureErrors(), FIXTURE);
    const allButBase = TIERS.filter((tier) => tier !== 'base');
    expect(ratchetProblems(tiers, allButBase)).toEqual(['profile is listed as clean but has 2 strict errors.']);
    expect(ratchetProblems(tiers, allButBase.filter((tier) => tier !== 'profile'))).toEqual([]);
  });

  it('fails a clean tier that is not listed, so the list only grows', () => {
    const { tiers } = byTier(fixtureErrors(), FIXTURE);
    const listed = TIERS.filter((tier) => tier !== 'base' && tier !== 'profile' && tier !== 'trade');
    expect(ratchetProblems(tiers, listed)).toEqual(['trade has no strict errors: add it to scripts/strict-tiers.json so it stays clean.']);
    expect(ratchetProblems(tiers, [...listed, 'trade', 'widgets'])).toEqual(['"widgets" is listed in scripts/strict-tiers.json but is not a tier.']);
  });

  it('puts a config that cannot be read in no tier, so the gate cannot pass on an empty program', () => {
    const { tiers, untiered } = byTier(strictDiagnostics(`${FIXTURE}missing.json`), FIXTURE);
    expect(untiered.length).toBeGreaterThan(0);
    expect([...tiers.values()].every((errors) => errors.length === 0)).toBe(true);
  });

  it('lists only real tiers, once each', () => {
    expect(list.clean.every((tier) => TIERS.includes(tier))).toBe(true);
    expect(new Set(list.clean).size).toBe(list.clean.length);
  });
});
