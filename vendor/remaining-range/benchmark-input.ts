/** Freezes a tracked project source excerpt and nearby README into one hashed benchmark prompt. All model/tier trials consume the same bytes; no generated prompt or analysis is saved. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const excluded = /(^|\/)(node_modules|archives|dist|build|generated|fixtures|vendor)(\/|$)|\.(test|spec|stories|d)\.[^.]+$|credentials|secrets/i;
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.swift']);
export type BenchmarkInput = ReturnType<typeof freezeInput>;

function within(project: string, path: string): string {
  const actual = realpathSync(resolve(project, path)), rel = relative(project, actual);
  if (rel.startsWith('..' + '/') || rel === '..' || isAbsolute(rel)) throw new Error('file_outside_project');
  if (!sourceExtensions.has(extname(actual)) || !statSync(actual).isFile()) throw new Error('file_must_be_source_code');
  return actual;
}

function selectSource(project: string): string {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', '.'], { cwd: project, encoding: 'utf8', maxBuffer: 8_000_000 });
  const candidates = tracked.split('\0').filter(p => p && sourceExtensions.has(extname(p)) && !excluded.test(p))
    .sort((a, b) => Number(!/\.tsx?$/.test(a)) - Number(!/\.tsx?$/.test(b))
      || Number(!a.includes('/src/')) - Number(!b.includes('/src/')) || a.localeCompare(b));
  for (const path of candidates) {
    const actual = within(project, path);
    if (statSync(actual).size > 80_000) continue;
    const lines = readFileSync(actual, 'utf8').split('\n');
    if (lines.length >= 100 && lines.length <= 500 && /\b(function|class|const|func|fn)\b/.test(lines.join('\n'))) return actual;
  }
  throw new Error('no_suitable_tracked_source_use_--file');
}

export function freezeInput(projectPath: string, file?: string, startLine = 1, lineCount = 120) {
  const project = realpathSync(resolve(projectPath));
  if (!statSync(project).isDirectory()) throw new Error('project_must_be_a_directory');
  if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(lineCount) || lineCount < 20 || lineCount > 500) {
    throw new Error('source_lines_require_start>=1_and_count_between_20_and_500');
  }
  const path = file ? within(project, file) : selectSource(project);
  if (statSync(path).size > 80_000) throw new Error('source_file_exceeds_80000_bytes');
  const content = readFileSync(path, 'utf8'), lines = content.split('\n');
  if (startLine > lines.length) throw new Error('start_line_outside_file');
  const endLine = Math.min(lines.length, startLine + lineCount - 1);
  const source = lines.slice(startLine - 1, endLine).map((line, i) => `${startLine + i}: ${line}`).join('\n');
  if (source.length > 24_000) throw new Error('source_excerpt_exceeds_24000_characters');
  let directory = dirname(path), readme: string | null = null;
  while (true) {
    const candidate = join(directory, 'README.md');
    if (existsSync(candidate)) { readme = candidate; break; }
    if (directory === project) break;
    directory = dirname(directory);
  }
  const context = readme ? readFileSync(readme, 'utf8').slice(0, 2000) : 'No README exists in the source boundary.';
  const sourcePath = relative(project, path);
  const prompt = `Analyze the real project source below. Use only this frozen context. Do not call tools or edit files.
Write 250-350 English words with these sections: responsibility, control/data flow, edge cases, and two useful verification cases.
Cite exact source path:line evidence for behavior claims. Distinguish facts from inference; do not invent code outside this excerpt.
Return only the analysis, with no preliminary commentary. This is a single-response output-throughput benchmark.

Project: ${project}
README: ${readme ? relative(project, readme) : '(unavailable)'}
${context}

Source: ${sourcePath}:${startLine}-${endLine}
${source}`;
  return { prompt, metadata: { project, sourcePath, startLine, endLine, sourceSha256: digest(content),
    readmePath: readme ? relative(project, readme) : null, contextSha256: digest(context), promptSha256: digest(prompt),
    promptCharacters: prompt.length, outputTarget: '250-350 English words' } };
}
