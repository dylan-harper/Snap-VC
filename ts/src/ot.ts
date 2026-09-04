import type { EditOperation } from "./repository_model.js";

/**
 * Transform an incoming edit through an edit that has already been applied.
 *
 * `incoming` (P) and `context` (Q) both describe the same base token stream.
 * The returned edit describes P's effect on the result of applying Q.  Q's
 * inserts are retained before P is considered, which is Snap's canonical
 * integration order for concurrent inserts at one cursor.
 */
export function transformTextEdit(
  incoming: readonly EditOperation[],
  context: readonly EditOperation[],
): readonly EditOperation[] {
  validateEdit(incoming, "incoming");
  validateEdit(context, "context");

  const p = new Cursor(incoming);
  const q = new Cursor(context);
  const result: EditOperation[] = [];

  while (!p.done || !q.done) {
    const qOperation = q.current;
    const pOperation = p.current;

    if (qOperation !== undefined && "insert" in qOperation) {
      append(result, { retain: qOperation.insert.length });
      q.advance(qOperation.insert.length);
      continue;
    }
    if (pOperation !== undefined && "insert" in pOperation) {
      append(result, { insert: pOperation.insert });
      p.advance(pOperation.insert.length);
      continue;
    }

    if (pOperation === undefined || qOperation === undefined) {
      throw new TypeError("edits do not consume the same base token count");
    }

    const amount = Math.min(
      consumption(pOperation, p.remaining),
      consumption(qOperation, q.remaining),
    );
    if ("retain" in pOperation && "retain" in qOperation) {
      append(result, { retain: amount });
    } else if ("delete" in pOperation && "retain" in qOperation) {
      append(result, { delete: amount });
    }
    p.advance(amount);
    q.advance(amount);
  }

  return result;
}

class Cursor {
  private operationIndex = 0;
  private offset = 0;

  public constructor(private readonly operations: readonly EditOperation[]) {}

  public get current(): EditOperation | undefined {
    return this.operations[this.operationIndex];
  }

  public get remaining(): number {
    const operation = this.current;
    if (operation === undefined || "insert" in operation) return 0;
    return ("retain" in operation ? operation.retain : operation.delete) - this.offset;
  }

  public get done(): boolean {
    return this.operationIndex >= this.operations.length;
  }

  public advance(amount: number): void {
    const operation = this.current;
    if (operation === undefined) throw new TypeError("cannot advance an exhausted edit");
    if ("insert" in operation) {
      if (amount !== operation.insert.length) throw new TypeError("invalid insert advancement");
      this.operationIndex += 1;
      this.offset = 0;
      return;
    }
    this.offset += amount;
    const count = "retain" in operation ? operation.retain : operation.delete;
    if (this.offset === count) {
      this.operationIndex += 1;
      this.offset = 0;
    }
  }
}

function consumption(operation: EditOperation, remaining: number): number {
  if ("insert" in operation) throw new TypeError("insert does not consume base tokens");
  return remaining;
}

function append(result: EditOperation[], operation: EditOperation): void {
  const previous = result[result.length - 1];
  if (previous === undefined) {
    result.push(operation);
  } else if ("retain" in previous && "retain" in operation) {
    result[result.length - 1] = { retain: previous.retain + operation.retain };
  } else if ("delete" in previous && "delete" in operation) {
    result[result.length - 1] = { delete: previous.delete + operation.delete };
  } else if ("insert" in previous && "insert" in operation) {
    result[result.length - 1] = { insert: [...previous.insert, ...operation.insert] };
  } else {
    result.push(operation);
  }
}

function validateEdit(edit: readonly EditOperation[], label: string): void {
  let previous: "retain" | "delete" | "insert" | undefined;
  let consumed = 0;
  for (const operation of edit) {
    if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
      throw new TypeError(`${label} contains an invalid operation`);
    }
    const keys = Object.keys(operation);
    if (keys.length !== 1) throw new TypeError(`${label} contains an invalid operation`);
    const key = keys[0];
    if (key === "retain" || key === "delete") {
      const count = (operation as unknown as Record<string, unknown>)[key];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) {
        throw new TypeError(`${label} contains an invalid count`);
      }
      if (previous === key) throw new TypeError(`${label} contains adjacent ${key} operations`);
      if (consumed > Number.MAX_SAFE_INTEGER - count) throw new TypeError(`${label} is too large`);
      consumed += count;
      previous = key;
    } else if (key === "insert") {
      const tokens = (operation as unknown as Record<string, unknown>)[key];
      if (!Array.isArray(tokens) || tokens.length === 0) {
        throw new TypeError(`${label} contains an invalid insert`);
      }
      if (previous === key) throw new TypeError(`${label} contains adjacent insert operations`);
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (typeof token !== "string" || token.length === 0 || token.includes("\0")) {
          throw new TypeError(`${label} contains an invalid text token`);
        }
        const bytes = Buffer.from(token, "utf8");
        if (Buffer.from(bytes).toString("utf8") !== token || bytes.subarray(0, -1).includes(10)) {
          throw new TypeError(`${label} contains a non-canonical text token`);
        }
        if (index < tokens.length - 1 && !token.endsWith("\n")) {
          throw new TypeError(`${label} contains a non-canonical insert`);
        }
      }
      previous = key;
    } else {
      throw new TypeError(`${label} contains an unknown operation`);
    }
  }
}
