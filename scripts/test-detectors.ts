/**
 * Tests for the hallucination detector and asking-clarifying-question detector.
 */

import { parseToolCalls } from '../src/core/toolParser';

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}

// Re-implement the detectors here for testing (they're not exported from agentLoop).
function hallucinatedFileCompletion(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const persianPhrases = [
    'ساخته شد', 'ساخته‌شد', 'ساختم', 'ساخت',
    'ایجاد شد', 'ایجاد‌شد', 'ایجاد کردم', 'ایجاد شد.',
    'نوشته شد', 'نوشته‌شد', 'نوشتم', 'نوشته.',
    'ذخیره شد', 'ذخیره‌شد', 'ذخیره کردم', 'ذخیره شد.',
    'ویرایش شد', 'ویرایش‌شد', 'ویرایش کردم', 'ویرایش شد.',
    'فایل ساخته', 'فایل ایجاد', 'فایل نوشته', 'فایل ذخیره',
    'کد ساخته', 'کد ایجاد', 'کد نوشته', 'کد ذخیره',
  ];
  const englishPhrases = [
    'file created', 'file written', 'file saved', 'file edited',
    'file has been created', 'file has been written', 'file has been saved',
    'file was created', 'file was written', 'file was saved', 'file was edited',
    'file is created', 'file is written', 'file is saved',
    'i created the file', 'i wrote the file', 'i saved the file', 'i edited the file',
    'i created a', 'i wrote a', 'i made a',
    'the file was created', 'the file was written', 'the file was saved',
  ];
  return (
    persianPhrases.some((p) => text.includes(p)) ||
    englishPhrases.some((p) => lower.includes(p))
  );
}

function askingClarifyingQuestion(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const persianPhrases = [
    'بگویید', 'بفرمایید', 'چه کاری', 'چه چیزی', 'چه نوع',
    'لطفاً بگویید', 'لطفا بگویید', 'منتظر راهنمایی',
    'اگر ایده خاصی', 'اگر ایده‌ خاصی', 'اگر ایده‌ای',
    'می‌خواهید چه', 'میخواهید چه', 'دوست دارید چه',
    'مشخص کنید', 'توضیح دهید', 'راهنمایی کنید',
  ];
  const englishPhrases = [
    'what should', 'what would you like', 'please tell', 'please specify',
    'please describe', 'could you specify', 'what kind of',
    'what do you want', 'i need more information', 'please provide more',
  ];
  return (
    persianPhrases.some((p) => text.includes(p)) ||
    englishPhrases.some((p) => lower.includes(p))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] hallucinatedFileCompletion — Persian');
assert(hallucinatedFileCompletion('فایل todo_manager.py ساخته شد.'), 'ساخته شد detected');
assert(hallucinatedFileCompletion('فایل ایجاد شد.'), 'ایجاد شد detected');
assert(hallucinatedFileCompletion('کد ذخیره شد.'), 'ذخیره شد detected');
assert(hallucinatedFileCompletion('من فایل را ساختم.'), 'ساختم detected');
assert(!hallucinatedFileCompletion('لطفاً فایل را بسازید.'), 'imperative not flagged');

console.log('\n[2] hallucinatedFileCompletion — English');
assert(hallucinatedFileCompletion('The file was created successfully.'), 'file created detected');
assert(hallucinatedFileCompletion('I wrote the file to disk.'), 'I wrote the file detected');
assert(!hallucinatedFileCompletion('I will create the file now.'), 'future tense not flagged');

console.log('\n[3] askingClarifyingQuestion — Persian');
assert(askingClarifyingQuestion('لطفاً بگویید این کد قرار است چه کاری انجام دهد'), 'لطفاً بگویید detected');
assert(askingClarifyingQuestion('اگر ایده خاصی ندارید، می‌توانم...'), 'اگر ایده خاصی detected');
assert(askingClarifyingQuestion('منتظر راهنمایی شما هستم'), 'منتظر راهنمایی detected');
assert(askingClarifyingQuestion('می‌خواهید چه کاری انجام دهم؟'), 'می‌خواهید چه detected');
assert(!askingClarifyingQuestion('فایل ساخته شد.'), 'completion not flagged as question');

console.log('\n[4] askingClarifyingQuestion — English');
assert(askingClarifyingQuestion('What should the code do?'), 'what should detected');
assert(askingClarifyingQuestion('Please tell me what you want'), 'please tell detected');
assert(!askingClarifyingQuestion('The file is ready.'), 'statement not flagged');

console.log('\n[5] parseToolCalls — bare <|channel> (no thought keyword)');
{
  // The model emits a bare <|channel> without "thought" — should be parsed
  // as a thinking channel and stripped from prose.
  const r = parseToolCalls('<|channel>\nفایل ساخته شد.\n<channel|>');
  assert(r.thinking.includes('فایل ساخته شد'), 'bare channel thinking extracted');
  assert(!r.prose.includes('<|channel>'), 'bare channel stripped from prose');
  assert(!r.prose.includes('ساخته شد'), 'thinking content not in prose');
}

console.log('\n[6] parseToolCalls — canonical <|channel>thought');
{
  const r = parseToolCalls('<|channel>thought\nPlanning the file.\n<channel|>\nNow acting.');
  assert(r.thinking === 'Planning the file.', 'canonical thinking extracted');
  assert(r.prose === 'Now acting.', 'canonical prose correct');
}

console.log('\n[7] parseToolCalls — unclosed <|channel>');
{
  // Streaming or model forgot to close — the rest is treated as thinking
  const r = parseToolCalls('Hi <|channel>\npartial thinking');
  assert(r.thinking.includes('partial thinking'), 'unclosed thinking captured');
  assert(!r.prose.includes('<|channel>'), 'unclosed channel stripped from prose');
}

console.log('\n[8] parseToolCalls — orphan <|channel> tokens');
{
  // Model emitted bare tokens without proper structure
  const r = parseToolCalls('text <|channel> more text <channel|> end');
  assert(!r.prose.includes('<|channel>'), 'orphan open token stripped');
  assert(!r.prose.includes('<channel|>'), 'orphan close token stripped');
  assert(r.prose.includes('text'), 'prose text preserved');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
