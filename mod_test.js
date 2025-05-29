import { after, before, describe, it } from "node:test";
import assert from "node:assert";

import { serve } from "@sntran/serve";

import { HTMLRewriter } from "./mod.js";

function server(options = {}) {
  return new Promise((onListen) => {
    serve({
      port: 0,
      fetch(request) {
        return new Response(
          `
          <h1 class="hero">HTMLRewriter</h1>
        `,
          {
            headers: {
              "Content-Type": "text/html",
            },
          },
        );
      },
      ...options,
      onListen,
    });
  });
}

describe("transform", async () => {
  const abortController = new AbortController();
  let url;

  before(async () => {
    const { hostname, port } = await server({
      signal: abortController.signal,
    });
    url = `http://${hostname}:${port}`;
  });

  after(() => {
    abortController.abort();
  });

  it("should not modify response without any handler", async () => {
    const response = await fetch(url);
    const rewriter = new HTMLRewriter();
    assert.deepEqual(rewriter.transform(response), response);
  });

  it("should not modify body without handler", async () => {
    const response = await fetch(url);
    const clone = response.clone();
    const body = await clone.bytes();

    const rewriter = new HTMLRewriter();
    assert.deepEqual(await rewriter.transform(response).bytes(), body);
  });

  it("should transform", async () => {
    let response = await fetch(url);
    const rewriter = new HTMLRewriter();
    rewriter.on("h1[class]", {
      element(element) {
        element.tagName = "h2";
        const className = element.getAttribute("class");
        element.setAttribute("class", `${className} test`);
      },
    });
    response = rewriter.transform(response);

    const html = await response.text();
    assert.match(html, /<h2 class="hero test">/);
  });
});
