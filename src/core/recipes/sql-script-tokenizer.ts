/**
 * Test support: a quote-aware, comment-aware splitter for SQL scripts. Returns
 * the statements (terminated by `;` outside quotes and comments) and the code
 * text with quoted strings, quoted identifiers, and comments removed.
 */
export function tokenizeScript(script: string): {
  statements: string[];
  codeOnly: string;
} {
  const statements: string[] = [];
  let current = "";
  let code = "";
  let i = 0;
  while (i < script.length) {
    const ch = script[i];
    if (ch === "-" && script[i + 1] === "-") {
      while (i < script.length && script[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      current += ch;
      i += 1;
      while (i < script.length) {
        if (script[i] === quote) {
          if (script[i + 1] === quote) {
            current += quote + quote;
            i += 2;
            continue;
          }
          break;
        }
        current += script[i];
        i += 1;
      }
      current += quote;
      i += 1;
      code += " ";
      continue;
    }
    if (ch === ";") {
      statements.push(current.trim());
      current = "";
      code += ";";
      i += 1;
      continue;
    }
    current += ch;
    code += ch;
    i += 1;
  }
  if (current.trim() !== "") statements.push(current.trim());
  return { statements, codeOnly: code };
}
