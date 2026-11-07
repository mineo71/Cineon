// Answers requests from a table instead of the network, and remembers what was asked. The fetch
// counterpart of windows/Cineon.Core.Tests/Metadata/FakeHttp.cs.

import type { Fetch } from "../../src/core/metadata/metadataClient";

export interface Sent {
  url: string;
  init: RequestInit | undefined;
}

export class FakeFetch {
  readonly requests: Sent[] = [];

  constructor(private readonly answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {}

  /** Exact addresses to bodies; anything else is a 404. */
  static routes(routes: Record<string, string>): FakeFetch {
    return new FakeFetch((url) => (Object.hasOwn(routes, url) ? FakeFetch.json(routes[url]!) : new Response("", { status: 404 })));
  }

  static json(body: string, status = 200): Response {
    return new Response(body, { status, headers: { "content-type": "application/json; charset=utf-8" } });
  }

  static bytes(body: Uint8Array<ArrayBuffer>, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(body, { status, headers });
  }

  readonly fetch: Fetch = async (url, init) => {
    this.requests.push({ url, init });
    return this.answer(url, init);
  };

  get addresses(): string[] {
    return this.requests.map((r) => r.url);
  }

  header(index: number, name: string): string | undefined {
    const headers = this.requests[index]?.init?.headers as Record<string, string> | undefined;
    return headers?.[name];
  }
}
