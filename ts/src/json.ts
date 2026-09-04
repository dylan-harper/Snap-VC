export class JsonError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "JsonError";
  }
}

/** Parse JSON while rejecting duplicate object keys and trailing content. */
export function parseJsonUnique(text: unknown): unknown {
  if (typeof text !== "string") {
    throw new JsonError("invalid JSON input");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new JsonError(message);
  }
  const scanner = new JsonScanner(text);
  scanner.value("$");
  scanner.space();
  if (!scanner.done()) {
    throw new JsonError("unexpected trailing JSON content");
  }
  return value;
}

class JsonScanner {
  private index = 0;

  public constructor(private readonly text: string) {}

  public done(): boolean {
    return this.index === this.text.length;
  }

  public space(): void {
    while (/\s/u.test(this.text[this.index] ?? "")) this.index++;
  }

  public value(path: string): void {
    this.space();
    const character = this.text[this.index];
    if (character === "{") return this.object(path);
    if (character === "[") return this.array(path);
    if (character === '"') {
      this.string();
      return;
    }
    this.primitive();
  }

  private object(path: string): void {
    this.index++;
    this.space();
    const keys = new Set<string>();
    if (this.text[this.index] === "}") {
      this.index++;
      return;
    }
    while (true) {
      this.space();
      if (this.text[this.index] !== '"') {
        throw new JsonError(`expected JSON key at ${path}`);
      }
      const key = this.string();
      if (keys.has(key)) {
        throw new JsonError(`duplicate JSON key at ${path}.${key}`);
      }
      keys.add(key);
      this.space();
      this.expect(":");
      this.value(`${path}.${key}`);
      this.space();
      const delimiter = this.text[this.index++];
      if (delimiter === "}") return;
      if (delimiter !== ",") throw new JsonError("invalid JSON object");
    }
  }

  private array(path: string): void {
    this.index++;
    this.space();
    if (this.text[this.index] === "]") {
      this.index++;
      return;
    }
    let index = 0;
    while (true) {
      this.value(`${path}[${index++}]`);
      this.space();
      const delimiter = this.text[this.index++];
      if (delimiter === "]") return;
      if (delimiter !== ",") throw new JsonError("invalid JSON array");
    }
  }

  private string(): string {
    const start = this.index;
    this.expect('"');
    while (this.index < this.text.length) {
      const character = this.text[this.index++];
      if (character === '"') {
        try {
          return JSON.parse(this.text.slice(start, this.index)) as string;
        } catch {
          throw new JsonError("invalid JSON string");
        }
      }
      if (character === "\\") {
        const escaped = this.text[this.index++];
        if (escaped === "u") this.index += 4;
      }
    }
    throw new JsonError("unterminated JSON string");
  }

  private primitive(): void {
    const start = this.index;
    while (this.index < this.text.length && !/[\s,\]}]/u.test(this.text[this.index] ?? "")) {
      this.index++;
    }
    if (this.index === start) throw new JsonError("invalid JSON value");
  }

  private expect(character: string): void {
    if (this.text[this.index] !== character) {
      throw new JsonError(`expected ${character} in JSON`);
    }
    this.index++;
  }
}
