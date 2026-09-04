import { createServer, type Server } from "node:http";
import { URL } from "node:url";
import { Utf8Error, decodeUtf8 } from "./utf8.js";

export class HttpRepositoryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HttpRepositoryError";
  }
}

function repositoryUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpRepositoryError(`invalid repository URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpRepositoryError(`invalid repository URL: ${value}`);
  }
  return url;
}

/** Fetch exactly one repository resource; redirects are deliberately not followed. */
export async function fetchRepositoryJson(value: string): Promise<string> {
  const url = repositoryUrl(value);
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", redirect: "manual" });
  } catch (error) {
    throw new HttpRepositoryError(
      error instanceof Error ? `HTTP request failed: ${error.message}` : "HTTP request failed",
    );
  }
  if (response.status !== 200) throw new HttpRepositoryError(`HTTP ${response.status}`);
  try {
    return decodeUtf8(new Uint8Array(await response.arrayBuffer()), "HTTP repository response");
  } catch (error) {
    if (error instanceof Utf8Error) throw new HttpRepositoryError(error.message);
    throw new HttpRepositoryError("cannot read HTTP response");
  }
}

export interface RepositoryServer {
  readonly url: string;
  readonly server: Server;
  close(): Promise<void>;
}

/** Serve one already-validated, immutable repository snapshot. */
export async function startRepositoryServer(
  snapshot: string,
  port: number,
): Promise<RepositoryServer> {
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/repository.json" || requestUrl.search !== "") {
      response.statusCode = 404;
      response.end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET, HEAD");
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Length", Buffer.byteLength(snapshot, "utf8"));
    if (request.method === "HEAD") response.end();
    else response.end(snapshot, "utf8");
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(new HttpRepositoryError(`cannot start server: ${error.message}`));
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new HttpRepositoryError("server did not provide a TCP address");
  }
  return {
    url: `http://127.0.0.1:${address.port}/repository.json`,
    server,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

export function parseServerPort(value: string | undefined): number {
  if (value === undefined) return 8765;
  if (!/^\d+$/u.test(value)) throw new HttpRepositoryError(`invalid port: ${value}`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw new HttpRepositoryError(`invalid port: ${value}`);
  }
  return port;
}
