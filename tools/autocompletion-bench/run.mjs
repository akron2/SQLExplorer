import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const executable = path.join(directory, process.platform === 'win32' ? 'harness.exe' : 'harness');

if (!fs.existsSync(executable)) {
  const build = spawnSync('go', ['build', '-o', executable, '.'], {
    cwd: directory,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (build.error || build.status !== 0) {
    console.error('Не удалось собрать harness. Установите Go и повторите.');
    console.error(build.error ?? build.stderr ?? build.stdout);
    process.exit(1);
  }
}

const corpus = fs.readFileSync(path.join(directory, 'corpus.jsonl'), 'utf8');
const run = spawnSync(executable, [], { cwd: directory, input: corpus, encoding: 'utf8' });
if (run.error || run.status !== 0) {
  console.error(run.error ?? run.stderr);
  process.exit(1);
}

const scenarios = corpus.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const results = run.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
if (scenarios.length !== results.length) {
  console.error(`Несовпадение числа сценариев: ${scenarios.length} против ${results.length}`);
  process.exit(1);
}

let failures = 0;
for (let index = 0; index < scenarios.length; index += 1) {
  const scenario = scenarios[index];
  const result = results[index];
  const texts = (result.candidates ?? []).map((candidate) => candidate.text);
  const missing = scenario.expected.filter((value) =>
    !texts.some((text) => text.toLocaleLowerCase() === value.toLocaleLowerCase()));
  const status = result.error ? `ОШИБКА ${result.error}` : missing.length ? `НЕ НАЙДЕНО ${missing.join(', ')}` : 'ок';
  if (result.error || missing.length) failures += 1;
  console.log(`${scenario.name}: ${status} · ${result.elapsedMs.toFixed(2)} мс · кандидаты: ${texts.slice(0, 10).join(', ')}`);
}
const timings = results.map((result) => result.elapsedMs).sort((left, right) => left - right);
console.log(`\nсценариев=${scenarios.length} провалов=${failures}`);
if (timings.length) {
  console.log(`задержка мс: мин=${timings[0].toFixed(2)} медиана=${timings[Math.floor(timings.length / 2)].toFixed(2)} макс=${timings[timings.length - 1].toFixed(2)}`);
}
process.exit(failures ? 1 : 0);
