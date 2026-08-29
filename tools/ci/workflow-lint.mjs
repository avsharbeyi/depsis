// İş akışı dosyaları GitHub'ın kabul edeceği şekilde mi.
//
// NEDEN VAR. Bir iş akışı dosyası GitHub tarafından REDDEDİLİRSE hiçbir iş koşmaz: koşum sıfır
// saniyede `startup_failure` ile biter ve dalda tek bir kırmızı tik görünür. Yani CI'ın kendisi
// bu hatayı yakalayamaz — yakalayacak yer burası, `pnpm check`'in içi.
//
// Bu tam olarak yaşandı: bir adıma ikinci bir `env:` anahtarı eklendi. Python'ın `yaml.safe_load`'u
// yinelenen anahtarı sessizce yutup son değeri aldı, dosya "geçerli" göründü, GitHub ise doğrudan
// reddetti. YAML belirtimi yinelenen anahtarı hata sayar; `yaml` paketi de öyle — kontrol,
// hoşgörülü bir ayrıştırıcı yerine katı olanı kullanmaktan ibaret.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseDocument } from 'yaml';

const DIR = '.github/workflows';
const problems = [];

for (const name of readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
  const path = join(DIR, name);
  const doc = parseDocument(readFileSync(path, 'utf8'), { uniqueKeys: true });

  for (const error of doc.errors) {
    problems.push(`${path}: ${error.message.split('\n')[0]}`);
  }
  for (const warning of doc.warnings) {
    problems.push(`${path}: ${warning.message.split('\n')[0]}`);
  }
  if (doc.errors.length > 0) {
    continue;
  }

  const workflow = doc.toJS();
  // `on` YAML 1.1'de bir mantıksal değerdir; `yaml` paketi 1.2 okuduğu için dizge kalır, ama bir
  // gün başka bir araç `true` yaparsa tetikleyiciler sessizce kaybolur. İkisi de kabul.
  const triggers = workflow?.on ?? workflow?.[true];
  if (triggers === undefined) {
    problems.push(`${path}: tetikleyici yok (\`on:\`) — bu dosya hiç koşmaz`);
  }
  for (const [id, job] of Object.entries(workflow?.jobs ?? {})) {
    if (job?.['runs-on'] === undefined && job?.uses === undefined) {
      problems.push(`${path}: "${id}" işinin \`runs-on\`'u yok`);
    }
    for (const [index, step] of (job?.steps ?? []).entries()) {
      if (step?.run === undefined && step?.uses === undefined) {
        problems.push(`${path}: "${id}" işinin ${index + 1}. adımı ne \`run\` ne \`uses\` taşıyor`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error('İş akışı dosyaları GitHub tarafından reddedilirdi:\n');
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}
console.log(`İş akışı dosyaları geçerli (${readdirSync(DIR).length} dosya).`);
