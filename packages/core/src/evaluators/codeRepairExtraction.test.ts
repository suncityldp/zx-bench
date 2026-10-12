import { describe, expect, it } from 'vitest';
import { heuristicExtractCode } from './codeRepair.js';

describe('unfenced SQL and Shell repair extraction', () => {
  it('extracts a single SQL query after an answer-first label', () => {
    expect(heuristicExtractCode('ANSWER: SELECT id FROM users WHERE id = 1;', 'sql', 'query'))
      .toBe('SELECT id FROM users WHERE id = 1;');
    expect(heuristicExtractCode('ANSWER:\nWITH x AS (SELECT 1 AS n) SELECT n FROM x;', 'sql', 'query'))
      .toBe('WITH x AS (SELECT 1 AS n) SELECT n FROM x;');
  });

  it('extracts a plain Bash function rather than only its indented body', () => {
    const output = 'top_ips() {\n  awk \'{print $1}\' "$1" | sort | uniq -c\n}';
    expect(heuristicExtractCode(output, 'bash', 'top_ips')).toBe(output);
    expect(heuristicExtractCode(`ANSWER:\n${output}`, 'bash', 'top_ips')).toBe(output);
  });

  it('does not mistake ordinary prose for code', () => {
    expect(heuristicExtractCode('This query needs an index.', 'sql', 'query')).toBeNull();
  });
  it('keeps an unfenced PHP function intact across blank lines and excludes trailing prose', () => {
    const fn = 'function padCenterUnicode($s, $n) {\n    $length = mb_strlen($s);\n    $pad = max(0, $n - $length);\n\n    if ($pad === 0) {\n        return $s;\n    }\n    return str_repeat(" ", $pad) . $s;\n}';
    expect(heuristicExtractCode('ANSWER:\n'+fn+'\n说明文字', 'php', 'padCenterUnicode')).toBe(fn);
  });
  it('ignores braces in PHP comments, escaped strings and heredocs', () => {
    const fn = ['function example() {','  $url = "https://x/{";','  $s = \'\\\' }\';','  /* }','   * { */','  # }','  $x = <<<\'BODY\'','{ } }','BODY;','  return $s;','}'].join('\n');
    expect(heuristicExtractCode(fn+'\ntrailing prose', 'php', 'example')).toBe(fn);
  });
});
