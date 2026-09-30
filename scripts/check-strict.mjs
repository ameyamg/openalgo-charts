// @ts-check
/**
 * The stricter compiler flags, adopted one tier at a time.
 *
 * tsconfig.json is `strict`, but two flags that catch real mistakes stay off
 * because turning them on at once would mean fixing thousands of lines in one
 * change: `noUncheckedIndexedAccess` (an index read may be undefined) and
 * `exactOptionalPropertyTypes` (an optional property is absent, which is not
 * the same as present and undefined). tsconfig.strict.json is the main config
 * with both on. This script compiles `src` under it and counts the errors per
 * tier, and scripts/strict-tiers.json lists the tiers that have none.
 *
 * A config per tier cannot answer "is this tier clean". Every tier imports
 * `openalgo-charts`, which the `paths` mapping resolves to src/index.ts, so a
 * config that includes only src/profile still type-checks the whole base and
 * reports its errors too. The script therefore compiles the whole of `src` as
 * one program and attributes each diagnostic by the path of the file it is in:
 * src/<tier>/ for each tier named in package.json `exports`, and the base for
 * every other file under src (src/render/webgl is base; src/webgl is the tier).
 * An error in a file outside src, or with no file at all (a config error),
 * belongs to no tier and always fails.
 *
 * It is a ratchet, like scripts/line-caps.json. The check fails when a listed
 * tier has an error, and also when a tier with no errors is missing from the
 * list, so a tier that becomes clean is listed in the same change and stays
 * clean from then on. When every tier is listed, the flags move into
 * tsconfig.json and this script, its list and tsconfig.strict.json go.
 *
 * To see one tier's errors while fixing it:
 *
 *   npx tsc --noEmit -p tsconfig.strict.json | grep "^src/draw/"
 *
 * Usage: npm run typecheck:strict
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} rel */
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

/** Every tier, from the package's own entry points: '.' is the base. */
export const TIERS = Object.keys(readJson('package.json').exports)
  .map((key) => (key === '.' ? 'base' : key.slice(2)));

/**
 * The tier a file belongs to, from its path relative to the project root, or
 * null for a file outside src.
 *
 * @param {string} file relative path with forward slashes
 * @returns {string | null}
 */
export function tierOf(file) {
  if (!file.startsWith('src/')) return null;
  const dir = file.split('/')[1] ?? '';
  return dir !== 'base' && TIERS.includes(dir) ? dir : 'base';
}

/**
 * The errors the compiler reports for a config, including errors in the
 * config itself.
 *
 * @param {string} configPath
 * @returns {ts.Diagnostic[]}
 */
export function strictDiagnostics(configPath) {
  /** @type {ts.Diagnostic[]} */
  const configErrors = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => { configErrors.push(d); },
  });
  if (parsed === undefined) return configErrors;
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  return [...configErrors, ...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
}

/**
 * Errors grouped by tier, attributed by the path of the file each is in. Every
 * tier has an entry, empty when it is clean; `untiered` holds the rest.
 *
 * @param {readonly ts.Diagnostic[]} diagnostics
 * @param {string} root the directory tier paths are relative to
 */
export function byTier(diagnostics, root) {
  /** @type {Map<string, ts.Diagnostic[]>} */
  const tiers = new Map(TIERS.map((tier) => [tier, []]));
  /** @type {ts.Diagnostic[]} */
  const untiered = [];
  for (const d of diagnostics) {
    const file = d.file ? relative(root, d.file.fileName).split(sep).join('/') : null;
    const tier = file === null ? null : tierOf(file);
    (tier === null ? untiered : /** @type {ts.Diagnostic[]} */ (tiers.get(tier))).push(d);
  }
  return { tiers, untiered };
}

/**
 * What the ratchet rejects, one sentence per problem; empty when it passes.
 *
 * @param {ReadonlyMap<string, readonly ts.Diagnostic[]>} tiers errors per tier
 * @param {readonly string[]} clean the tiers scripts/strict-tiers.json lists
 * @returns {string[]}
 */
export function ratchetProblems(tiers, clean) {
  const problems = clean
    .filter((tier) => !tiers.has(tier))
    .map((tier) => `"${tier}" is listed in scripts/strict-tiers.json but is not a tier.`);
  for (const [tier, errors] of tiers) {
    if (clean.includes(tier) && errors.length > 0) {
      problems.push(`${tier} is listed as clean but has ${errors.length} strict errors.`);
    } else if (!clean.includes(tier) && errors.length === 0) {
      problems.push(`${tier} has no strict errors: add it to scripts/strict-tiers.json so it stays clean.`);
    }
  }
  return problems;
}

/** @type {ts.FormatDiagnosticsHost} */
const FORMAT = {
  getCanonicalFileName: (name) => name,
  getCurrentDirectory: () => ROOT,
  getNewLine: () => '\n',
};

function main() {
  const { clean } = readJson('scripts/strict-tiers.json');
  const { tiers, untiered } = byTier(strictDiagnostics(join(ROOT, 'tsconfig.strict.json')), ROOT);

  console.log('Strict errors per tier (tsconfig.strict.json):');
  for (const [tier, errors] of tiers) {
    const files = new Set(errors.map((d) => d.file?.fileName)).size;
    const status = clean.includes(tier) ? 'listed clean' : 'not yet';
    console.log(`  ${tier.padEnd(11)} ${String(errors.length).padStart(5)} errors in ${String(files).padStart(3)} files  ${status}`);
  }

  const problems = ratchetProblems(tiers, clean);
  const shown = clean.flatMap((tier) => tiers.get(tier) ?? []);
  if (untiered.length > 0) {
    problems.push(`${untiered.length} errors are outside every tier.`);
    shown.push(...untiered);
  }
  if (shown.length > 0) console.error(`\n${ts.formatDiagnostics(shown, FORMAT)}`);
  for (const problem of problems) console.error(`check-strict: ${problem}`);
  if (problems.length > 0) process.exit(1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
