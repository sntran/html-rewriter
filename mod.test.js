import { suite, test } from "node:test";
import assert from "node:assert/strict";
import { HTMLRewriter } from "./mod.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a streaming Response from an HTML string, optionally chunked.
 * Small chunk sizes stress boundary handling in the streaming parser.
 */
function createResponse(html, chunkSize = 15) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let pos = 0;
      while (pos < html.length) {
        controller.enqueue(encoder.encode(html.slice(pos, pos + chunkSize)));
        pos += chunkSize;
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/html",
      "Content-Length": String(encoder.encode(html).length),
      "X-Custom": "preserved",
    },
  });
}

/** Consume a Response body and return the full text. */
async function text(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode(); // flush
  return result;
}

suite("Fluent API", () => {
  test("on() returns the HTMLRewriter instance for chaining", () => {
    const rw = new HTMLRewriter();
    assert.equal(rw.on("div", {}), rw);
  });

  test("onDocument() returns the HTMLRewriter instance for chaining", () => {
    const rw = new HTMLRewriter();
    assert.equal(rw.onDocument({}), rw);
  });

  test("on() and onDocument() can be chained together", () => {
    const rw = new HTMLRewriter();
    const result = rw
      .on("div", { element() {} })
      .onDocument({ end() {} });
    assert.equal(result, rw);
  });
});

suite("transform() semantics", () => {
  test("transform() returns a Response", async () => {
    const rw = new HTMLRewriter();
    const res = rw.transform(createResponse("<p>hi</p>"));
    assert.ok(res instanceof Response);
  });

  test("transform() preserves status and statusText", async () => {
    const original = new Response("<p>ok</p>", {
      status: 404,
      statusText: "Not Found",
      headers: { "Content-Type": "text/html" },
    });
    const res = new HTMLRewriter().transform(original);
    assert.equal(res.status, 404);
    assert.equal(res.statusText, "Not Found");
  });

  test("transform() preserves custom headers", async () => {
    const res = new HTMLRewriter().transform(createResponse("<p>hi</p>"));
    assert.equal(res.headers.get("X-Custom"), "preserved");
  });

  test("transform() strips Content-Length header", async () => {
    const res = new HTMLRewriter().transform(createResponse("<p>hi</p>"));
    assert.equal(res.headers.has("Content-Length"), false);
  });

  test("transform() passes through body unchanged when no handlers match", async () => {
    const html = "<div><span>hello</span></div>";
    const res = new HTMLRewriter().transform(createResponse(html));
    assert.equal(await text(res), html);
  });
});

suite(".element() — sync", () => {
  test("element handler fires for matching selector", async () => {
    const html = "<h1>Old</h1>";
    const res = new HTMLRewriter()
      .on("h1", {
        element(el) {
          el.setInnerContent("New");
        },
      })
      .transform(createResponse(html));
    assert.equal(await text(res), "<h1>New</h1>");
  });

  test("element handler — tagName read/write", async () => {
    const html = "<div>Keep</div>";
    const res = new HTMLRewriter()
      .on("div", {
        element(el) {
          assert.equal(el.tagName, "div");
          el.tagName = "section";
        },
      })
      .transform(createResponse(html));
    assert.equal(await text(res), "<section>Keep</section>");
  });

  test("element handler — getAttribute / setAttribute / hasAttribute / removeAttribute", async () => {
    const html = '<a href="/old" class="link">click</a>';
    const res = new HTMLRewriter()
      .on("a", {
        element(el) {
          assert.equal(el.getAttribute("href"), "/old");
          assert.equal(el.hasAttribute("class"), true);
          el.setAttribute("href", "/new");
          el.removeAttribute("class");
          assert.equal(el.hasAttribute("class"), false);
        },
      })
      .transform(createResponse(html));
    const result = await text(res);
    assert.match(result, /href=\"\/new\"/);
    assert.ok(!result.includes("class="));
  });

  test("element handler — attributes iterator", async () => {
    const html = '<img src="a.png" alt="pic" />';
    const attrs = [];
    const res = new HTMLRewriter()
      .on("img", {
        element(el) {
          for (const [name, value] of el.attributes) {
            attrs.push([name, value]);
          }
        },
      })
      .transform(createResponse(html));
    await text(res); // consume
    assert.deepEqual(attrs, [["src", "a.png"], ["alt", "pic"]]);
  });

  test("element handler — before / after", async () => {
    const html = "<p>mid</p>";
    const res = new HTMLRewriter()
      .on("p", {
        element(el) {
          el.before("<span>before</span>", { html: true });
          el.after("<span>after</span>", { html: true });
        },
      })
      .transform(createResponse(html));
    assert.equal(
      await text(res),
      "<span>before</span><p>mid</p><span>after</span>",
    );
  });

  test("element handler — prepend / append", async () => {
    const html = "<div>body</div>";
    const res = new HTMLRewriter()
      .on("div", {
        element(el) {
          el.prepend("<em>A</em>", { html: true });
          el.append("<em>B</em>", { html: true });
        },
      })
      .transform(createResponse(html));
    assert.equal(await text(res), "<div><em>A</em>body<em>B</em></div>");
  });

  test("element handler — replace", async () => {
    const html = "<b>old</b>";
    const res = new HTMLRewriter()
      .on("b", {
        element(el) {
          el.replace("<i>new</i>", { html: true });
        },
      })
      .transform(createResponse(html));
    assert.equal(await text(res), "<i>new</i>");
  });

  test("element handler — remove", async () => {
    const html = "<div><b>gone</b><i>kept</i></div>";
    const res = new HTMLRewriter()
      .on("b", {
        element(el) {
          el.remove();
          assert.equal(el.removed, true);
        },
      })
      .transform(createResponse(html));
    assert.equal(await text(res), "<div><i>kept</i></div>");
  });

  test("element handler — removeAndKeepContent", async () => {
    const html = "<div><b>kept</b></div>";
    const res = new HTMLRewriter()
      .on("b", {
        element(el) {
          el.removeAndKeepContent();
        },
      })
      .transform(createResponse(html));
    assert.equal(await text(res), "<div>kept</div>");
  });

  test("element handler — setInnerContent with html option", async () => {
    const html = "<div>old</div>";
    const res = new HTMLRewriter()
      .on("div", {
        element(el) {
          el.setInnerContent("<b>new</b>", { html: true });
        },
      })
      .transform(createResponse(html));
    assert.equal(await text(res), "<div><b>new</b></div>");
  });

  test("element handler — setInnerContent without html escapes text", async () => {
    const html = "<div>old</div>";
    const res = new HTMLRewriter()
      .on("div", {
        element(el) {
          el.setInnerContent("<b>new</b>");
        },
      })
      .transform(createResponse(html));
    const result = await text(res);
    assert.ok(result.includes("&lt;b&gt;"));
  });

  test("element handler — onEndTag callback", async () => {
    const html = "<div>inside</div>";
    const res = new HTMLRewriter()
      .on("div", {
        element(el) {
          el.onEndTag((endTag) => {
            assert.equal(endTag.name, "div");
            endTag.before(" appended", { html: false });
          });
        },
      })
      .transform(createResponse(html));
    assert.equal(await text(res), "<div>inside appended</div>");
  });

  test("element handler — namespaceURI", async () => {
    const html = "<div>test</div>";
    let ns;
    const res = new HTMLRewriter()
      .on("div", {
        element(el) {
          ns = el.namespaceURI;
        },
      })
      .transform(createResponse(html));
    await text(res);
    assert.equal(ns, "http://www.w3.org/1999/xhtml");
  });
});

// ===========================================================================
// 4. Text handler — sync
// ===========================================================================
suite(".text() — sync", () => {
  test("text handler fires for matching selector", async () => {
    const html = "<p>Hello World</p>";
    const chunks = [];
    const res = new HTMLRewriter()
      .on("p", {
        text(chunk) {
          chunks.push(chunk.text);
        },
      })
      .transform(createResponse(html));
    await text(res);
    assert.equal(chunks.join(""), "Hello World");
  });

  test("text handler — lastInTextNode", async () => {
    const html = "<p>Some text</p>";
    let sawLast = false;
    const res = new HTMLRewriter()
      .on("p", {
        text(chunk) {
          if (chunk.lastInTextNode) sawLast = true;
        },
      })
      .transform(createResponse(html));
    await text(res);
    assert.equal(sawLast, true);
  });

  test("text handler — replace", async () => {
    const html = "<p>old</p>";
    const res = new HTMLRewriter()
      .on("p", {
        text(chunk) {
          if (chunk.text) {
            chunk.replace("new");
          }
        },
      })
      .transform(createResponse(html));
    assert.equal(await text(res), "<p>new</p>");
  });

  test("text handler — remove", async () => {
    const html = "<p>gone</p>";
    const res = new HTMLRewriter()
      .on("p", {
        text(chunk) {
          chunk.remove();
        },
      })
      .transform(createResponse(html));
    assert.equal(await text(res), "<p></p>");
  });

  test("text handler — before / after", async () => {
    const html = "<p>mid</p>";
    const res = new HTMLRewriter()
      .on("p", {
        text(chunk) {
          if (chunk.text) {
            chunk.before("[");
            chunk.after("]");
          }
        },
      })
      .transform(createResponse(html));
    assert.equal(await text(res), "<p>[mid]</p>");
  });
});

suite(".comments() — sync", () => {
  test("comments handler fires for matching selector", async () => {
    const html = "<div><!-- hello --></div>";
    let commentText;
    const res = new HTMLRewriter()
      .on("div", {
        comments(comment) {
          commentText = comment.text;
        },
      })
      .transform(createResponse(html));
    await text(res);
    assert.equal(commentText.trim(), "hello");
  });

  test("comments handler — replace", async () => {
    const html = "<div><!-- old --></div>";
    const res = new HTMLRewriter()
      .on("div", {
        comments(comment) {
          comment.replace("new", { html: false });
        },
      })
      .transform(createResponse(html));
    assert.equal(await text(res), "<div>new</div>");
  });

  test("comments handler — remove", async () => {
    const html = "<div><!-- gone --><p>keep</p></div>";
    const res = new HTMLRewriter()
      .on("div", {
        comments(comment) {
          comment.remove();
          assert.equal(comment.removed, true);
        },
      })
      .transform(createResponse(html));
    const result = await text(res);
    assert.ok(!result.includes("<!--"));
    assert.ok(result.includes("<p>keep</p>"));
  });

  test("comments handler — before / after", async () => {
    const html = "<div><!-- c --></div>";
    const res = new HTMLRewriter()
      .on("div", {
        comments(comment) {
          comment.before("[");
          comment.after("]");
        },
      })
      .transform(createResponse(html));
    assert.equal(await text(res), "<div>[<!-- c -->]</div>");
  });
});

suite(".doctype() — sync", () => {
  test("doctype handler receives doctype properties", async () => {
    const html = "<!DOCTYPE html><html><body>hi</body></html>";
    let dt;
    const res = new HTMLRewriter()
      .onDocument({
        doctype(doctype) {
          dt = {
            name: doctype.name,
            publicId: doctype.publicId,
            systemId: doctype.systemId,
          };
        },
      })
      .transform(createResponse(html));
    await text(res);
    assert.equal(dt.name, "html");
  });
});

suite("Document comments handler (unscoped)", () => {
  test("document comments handler fires for top-level comments", async () => {
    const html = "<!-- top --><!DOCTYPE html><html><body>hi</body></html>";
    const comments = [];
    const res = new HTMLRewriter()
      .onDocument({
        comments(comment) {
          comments.push(comment.text.trim());
        },
      })
      .transform(createResponse(html));
    await text(res);
    assert.ok(comments.includes("top"));
  });
});

suite("Document text handler (unscoped)", () => {
  test("document text handler fires for all text", async () => {
    const html = "<p>a</p><p>b</p>";
    const chunks = [];
    const res = new HTMLRewriter()
      .onDocument({
        text(chunk) {
          if (chunk.text) chunks.push(chunk.text);
        },
      })
      .transform(createResponse(html));
    await text(res);
    assert.deepEqual(chunks, ["a", "b"]);
  });
});

suite("Document end handler", () => {
  test("document end handler can append content", async () => {
    const html = "<p>hi</p>";
    const res = new HTMLRewriter()
      .onDocument({
        end(end) {
          end.append("<!-- fin -->", { html: true });
        },
      })
      .transform(createResponse(html));
    const result = await text(res);
    assert.ok(result.endsWith("<!-- fin -->"));
  });
});

suite("Async element handlers (JSPI)", () => {
  test("async element handler suspends WASM and resolves", async () => {
    const html = '<div id="user">Loading...</div>';
    const res = new HTMLRewriter()
      .on("#user", {
        async element(el) {
          const data = await new Promise((r) =>
            setTimeout(() => r("Alice"), 50)
          );
          el.setInnerContent(`User: ${data}`);
        },
      })
      .transform(createResponse(html));
    assert.match(await text(res), /User: Alice/);
  });

  test("multiple async element handlers resolve correctly in sequence", async () => {
    const html = `<ul><li class="item">1</li><li class="item">2</li></ul>`;
    let counter = 0;
    const res = new HTMLRewriter()
      .on(".item", {
        async element(el) {
          await new Promise((r) => setTimeout(r, 10));
          counter++;
          el.setAttribute("data-n", String(counter));
        },
      })
      .transform(createResponse(html));
    const result = await text(res);
    assert.match(result, /data-n="1"/);
    assert.match(result, /data-n="2"/);
  });

  test("async text handler", async () => {
    const html = "<p>old</p>";
    const res = new HTMLRewriter()
      .on("p", {
        async text(chunk) {
          if (chunk.text) {
            await new Promise((r) => setTimeout(r, 20));
            chunk.replace("async-new");
          }
        },
      })
      .transform(createResponse(html));
    assert.equal(await text(res), "<p>async-new</p>");
  });

  test("async comments handler", async () => {
    const html = "<div><!-- original --></div>";
    const res = new HTMLRewriter()
      .on("div", {
        async comments(comment) {
          await new Promise((r) => setTimeout(r, 20));
          comment.replace("replaced");
        },
      })
      .transform(createResponse(html));
    assert.equal(await text(res), "<div>replaced</div>");
  });

  test("async document end handler", async () => {
    const html = "<p>hi</p>";
    const res = new HTMLRewriter()
      .onDocument({
        async end(end) {
          await new Promise((r) => setTimeout(r, 20));
          end.append("<!-- async-end -->", { html: true });
        },
      })
      .transform(createResponse(html));
    const result = await text(res);
    assert.ok(result.endsWith("<!-- async-end -->"));
  });

  test("async document doctype handler", async () => {
    const html = "<!DOCTYPE html><html><body>test</body></html>";
    let name;
    const res = new HTMLRewriter()
      .onDocument({
        async doctype(dt) {
          await new Promise((r) => setTimeout(r, 10));
          name = dt.name;
        },
      })
      .transform(createResponse(html));
    await text(res);
    assert.equal(name, "html");
  });

  test("async document text handler", async () => {
    const html = "<p>content</p>";
    const chunks = [];
    const res = new HTMLRewriter()
      .onDocument({
        async text(chunk) {
          await new Promise((r) => setTimeout(r, 5));
          if (chunk.text) chunks.push(chunk.text);
        },
      })
      .transform(createResponse(html));
    await text(res);
    assert.deepEqual(chunks, ["content"]);
  });

  test("async document comments handler", async () => {
    const html = "<!-- doc-comment --><p>hi</p>";
    let commentText;
    const res = new HTMLRewriter()
      .onDocument({
        async comments(c) {
          await new Promise((r) => setTimeout(r, 10));
          commentText = c.text.trim();
        },
      })
      .transform(createResponse(html));
    await text(res);
    assert.equal(commentText, "doc-comment");
  });
});

suite("Multiple selectors", () => {
  test("multiple on() calls with different selectors", async () => {
    const html = "<h1>Title</h1><p>Body</p>";
    const res = new HTMLRewriter()
      .on("h1", {
        element(el) {
          el.setInnerContent("New Title");
        },
      })
      .on("p", {
        element(el) {
          el.setInnerContent("New Body");
        },
      })
      .transform(createResponse(html));
    const result = await text(res);
    assert.match(result, /<h1>New Title<\/h1>/);
    assert.match(result, /<p>New Body<\/p>/);
  });

  test("element and text handlers on the same selector", async () => {
    const html = "<div>original</div>";
    let tagSeen = false;
    let textSeen = false;
    const res = new HTMLRewriter()
      .on("div", {
        element() {
          tagSeen = true;
        },
        text(chunk) {
          if (chunk.text) textSeen = true;
        },
      })
      .transform(createResponse(html));
    await text(res);
    assert.equal(tagSeen, true);
    assert.equal(textSeen, true);
  });
});

suite("Mixed sync + async handlers", () => {
  test("sync and async handlers on different selectors", async () => {
    const html = "<h1>A</h1><p>B</p>";
    const res = new HTMLRewriter()
      .on("h1", {
        element(el) {
          el.setInnerContent("SyncH1");
        },
      })
      .on("p", {
        async element(el) {
          await new Promise((r) => setTimeout(r, 20));
          el.setInnerContent("AsyncP");
        },
      })
      .transform(createResponse(html));
    const result = await text(res);
    assert.match(result, /SyncH1/);
    assert.match(result, /AsyncP/);
  });
});

suite("Streaming with small chunks", () => {
  test("works with very small chunk sizes (1 byte)", async () => {
    const html = "<div><span>hello</span></div>";
    const res = new HTMLRewriter()
      .on("span", {
        element(el) {
          el.setInnerContent("world");
        },
      })
      .transform(createResponse(html, 1)); // 1-byte chunks
    assert.equal(await text(res), "<div><span>world</span></div>");
  });
});

suite("Empty / null body", () => {
  test("transform() handles null body gracefully", async () => {
    const original = new Response(null, {
      headers: { "Content-Type": "text/html" },
    });
    const res = new HTMLRewriter()
      .on("div", { element() {} })
      .transform(original);
    assert.equal(await text(res), "");
  });
});

suite("CSS selector features", () => {
  test("attribute selector [attr=value]", async () => {
    const html = `<div data-x="1">a</div><div data-x="2">b</div>`;
    const res = new HTMLRewriter()
      .on(`[data-x="1"]`, {
        element(el) {
          el.setInnerContent("matched");
        },
      })
      .transform(createResponse(html));
    const result = await text(res);
    assert.match(result, /data-x="1">matched</);
    assert.match(result, /data-x="2">b</);
  });

  test("id selector #id", async () => {
    const html = '<p id="target">old</p><p>other</p>';
    const res = new HTMLRewriter()
      .on("#target", {
        element(el) {
          el.setInnerContent("new");
        },
      })
      .transform(createResponse(html));
    const result = await text(res);
    assert.match(result, /id="target">new</);
    assert.match(result, /<p>other<\/p>/);
  });

  test("class selector .class", async () => {
    const html = `<span class="hi">old</span>`;
    const res = new HTMLRewriter()
      .on(".hi", {
        element(el) {
          el.setInnerContent("new");
        },
      })
      .transform(createResponse(html));
    assert.match(await text(res), /class="hi">new</);
  });
});

suite("Reuse — separate transform calls", () => {
  test("HTMLRewriter instance can be reused for multiple transforms", async () => {
    const rw = new HTMLRewriter().on("p", {
      element(el) {
        el.setInnerContent("x");
      },
    });

    const r1 = await text(rw.transform(createResponse("<p>a</p>")));
    const r2 = await text(rw.transform(createResponse("<p>b</p>")));

    assert.equal(r1, "<p>x</p>");
    assert.equal(r2, "<p>x</p>");
  });
});

suite("Error propagation from handlers", () => {
  test("error in async element handler propagates", async () => {
    const html = "<div>test</div>";
    const res = new HTMLRewriter()
      .on("div", {
        async element() {
          await new Promise((r) => setTimeout(r, 10));
          throw new Error("handler-error");
        },
      })
      .transform(createResponse(html));

    await assert.rejects(text(res), (err) => {
      assert.ok(err.message.includes("handler-error"));
      return true;
    });
  });

  test("error in sync element handler propagates", async () => {
    const html = "<div>test</div>";
    const res = new HTMLRewriter()
      .on("div", {
        element() {
          throw new Error("sync-handler-error");
        },
      })
      .transform(createResponse(html));

    await assert.rejects(text(res));
  });
});

suite("Multiple document handlers", () => {
  test("multiple onDocument() handlers all fire", async () => {
    const html = "<!DOCTYPE html><html><body>hi</body></html>";
    let dtFired = false;
    let endFired = false;
    const res = new HTMLRewriter()
      .onDocument({
        doctype() {
          dtFired = true;
        },
      })
      .onDocument({
        end(end) {
          endFired = true;
          end.append("<!-- end -->", { html: true });
        },
      })
      .transform(createResponse(html));
    const result = await text(res);
    assert.equal(dtFired, true);
    assert.equal(endFired, true);
    assert.ok(result.endsWith("<!-- end -->"));
  });
});

suite("Empty string body", () => {
  test("transform() handles empty string body", async () => {
    const original = new Response("", {
      headers: { "Content-Type": "text/html" },
    });
    const res = new HTMLRewriter()
      .on("div", { element() {} })
      .transform(original);
    assert.equal(await text(res), "");
  });
});

suite("Async onEndTag handler (exercises endtag_* promising wrapping)", () => {
  test("async onEndTag handler suspends and resolves", async () => {
    const html = "<div>content</div>";
    const res = new HTMLRewriter()
      .on("div", {
        element(el) {
          el.onEndTag(async (endTag) => {
            await new Promise((r) => setTimeout(r, 10));
            endTag.before(" async-appended", { html: false });
          });
        },
      })
      .transform(createResponse(html));
    assert.equal(await text(res), "<div>content async-appended</div>");
  });
});

suite("Comment text mutation", () => {
  test("comments handler — read text and replace", async () => {
    const html = "<div><!-- old --></div>";
    let readText;
    const res = new HTMLRewriter()
      .on("div", {
        comments(comment) {
          readText = comment.text;
          comment.replace("replaced", { html: false });
        },
      })
      .transform(createResponse(html));
    const result = await text(res);
    assert.equal(readText.trim(), "old");
    assert.equal(result, "<div>replaced</div>");
  });
});

suite("Text handler — before / after with html option", () => {
  test("text handler — before / after with html option", async () => {
    const html = "<p>mid</p>";
    const res = new HTMLRewriter()
      .on("p", {
        text(chunk) {
          if (chunk.text) {
            chunk.before("<em>", { html: true });
            chunk.after("</em>", { html: true });
          }
        },
      })
      .transform(createResponse(html));
    assert.equal(await text(res), "<p><em>mid</em></p>");
  });
});

suite("Async element handler — setAttribute from async context", () => {
  test("async element handler can call setAttribute after await", async () => {
    const html = "<span>test</span>";
    const res = new HTMLRewriter()
      .on("span", {
        async element(el) {
          await new Promise((r) => setTimeout(r, 10));
          el.setAttribute("data-async", "true");
        },
      })
      .transform(createResponse(html));
    const result = await text(res);
    assert.match(result, /data-async="true"/);
  });
});

suite(
  "Async document end handler (exercises documentend_append promising)",
  () => {
    test("async document end handler appends with delay", async () => {
      const html = "<p>content</p>";
      const res = new HTMLRewriter()
        .onDocument({
          async end(end) {
            await new Promise((r) => setTimeout(r, 30));
            end.append("<!-- delayed -->", { html: true });
          },
        })
        .transform(createResponse(html));
      const result = await text(res);
      assert.ok(result.endsWith("<!-- delayed -->"));
    });
  },
);

suite("No-op handler (handler with no callbacks)", () => {
  test("empty handler object does not interfere", async () => {
    const html = "<div>keep</div>";
    const res = new HTMLRewriter()
      .on("div", {})
      .onDocument({})
      .transform(createResponse(html));
    assert.equal(await text(res), html);
  });
});

suite("Large document — stress streaming", () => {
  test("handles large document with many elements", async () => {
    const items = Array.from({ length: 200 }, (_, i) => `<li>${i}</li>`).join(
      "",
    );
    const html = `<ul>${items}</ul>`;
    let count = 0;
    const res = new HTMLRewriter()
      .on("li", {
        element() {
          count++;
        },
      })
      .transform(createResponse(html, 50));
    await text(res);
    assert.equal(count, 200);
  });
});

suite("Element handler — removed property (before remove)", () => {
  test("element removed is false before removal", async () => {
    const html = "<div>test</div>";
    let removedBefore;
    const res = new HTMLRewriter()
      .on("div", {
        element(el) {
          removedBefore = el.removed;
          el.remove();
        },
      })
      .transform(createResponse(html));
    await text(res);
    assert.equal(removedBefore, false);
  });
});

suite("Async comment handler (exercises comment_* promising wrapping)", () => {
  test("async comment handler can replace after await", async () => {
    const html = "<div><!-- placeholder --></div>";
    const res = new HTMLRewriter()
      .on("div", {
        async comments(comment) {
          await new Promise((r) => setTimeout(r, 10));
          comment.replace("async-replaced", { html: false });
        },
      })
      .transform(createResponse(html));
    assert.equal(await text(res), "<div>async-replaced</div>");
  });
});

suite("Async text handler (exercises textchunk_* promising wrapping)", () => {
  test("async text handler before/after with html", async () => {
    const html = "<p>word</p>";
    const res = new HTMLRewriter()
      .on("p", {
        async text(chunk) {
          if (chunk.text) {
            await new Promise((r) => setTimeout(r, 10));
            chunk.before("<b>", { html: true });
            chunk.after("</b>", { html: true });
          }
        },
      })
      .transform(createResponse(html));
    assert.equal(await text(res), "<p><b>word</b></p>");
  });
});

suite("WASM queue serialization and .free() safety", () => {
  test("concurrent transform() calls are serialized and do not interleave WASM stack", async () => {
    // This test creates two HTMLRewriter instances and runs transform() on both concurrently.
    // If the global WASM queue is not working, this will cause memory corruption or errors.
    const htmlA = "<div>A</div>";
    const htmlB = "<div>B</div>";
    const rwA = new HTMLRewriter().on("div", {
      async element(el) {
        await new Promise((r) => setTimeout(r, 30));
        el.setInnerContent("A1");
      },
    });
    const rwB = new HTMLRewriter().on("div", {
      async element(el) {
        await new Promise((r) => setTimeout(r, 10));
        el.setInnerContent("B1");
      },
    });
    // Start both transforms at the same time
    const [resultA, resultB] = await Promise.all([
      text(rwA.transform(createResponse(htmlA))),
      text(rwB.transform(createResponse(htmlB))),
    ]);
    assert.equal(resultA, "<div>A1</div>");
    assert.equal(resultB, "<div>B1</div>");
  });

  test(".free() is queued and does not interleave with WASM calls", async () => {
    // This test calls .free() manually during a transform to ensure it is queued and does not corrupt memory.
    const html = "<div>X</div>";
    let coreRef;
    const rw = new HTMLRewriter().on("div", {
      async element(el) {
        // Grab the internal core rewriter and call .free() while transform is in progress
        if (!coreRef && el.constructor && el.constructor.name === "Element") {
          // Try to access the internal core (not public API, but for test)
          coreRef = el._core || el.core || undefined;
        }
        await new Promise((r) => setTimeout(r, 5));
        el.setInnerContent("Y");
      },
    });
    // Try to call .free() during transform (simulate user error)
    const resPromise = text(rw.transform(createResponse(html)));
    if (coreRef && typeof coreRef.free === "function") {
      // Should not throw or corrupt memory
      coreRef.free();
    }
    const result = await resPromise;
    assert.equal(result, "<div>Y</div>");
  });

  test("queue recovers after a handler error — subsequent transforms succeed", async () => {
    // An error in one transform must NOT poison the shared WASM queue.
    const failing = new HTMLRewriter().on("div", {
      async element() {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("deliberate-failure");
      },
    });
    const failRes = failing.transform(createResponse("<div>x</div>"));
    await assert.rejects(text(failRes), (err) => {
      assert.ok(err.message.includes("deliberate-failure"));
      return true;
    });

    // A fresh transform after the failure must work correctly.
    const ok = new HTMLRewriter().on("div", {
      element(el) {
        el.setInnerContent("recovered");
      },
    });
    const result = await text(ok.transform(createResponse("<div>old</div>")));
    assert.equal(result, "<div>recovered</div>");
  });

  test("multiple sequential errors do not permanently break the queue", async () => {
    for (let i = 0; i < 3; i++) {
      const rw = new HTMLRewriter().on("p", {
        element() {
          throw new Error(`error-${i}`);
        },
      });
      await assert.rejects(text(rw.transform(createResponse("<p>x</p>"))));
    }
    // After 3 consecutive errors the queue must still work.
    const res = new HTMLRewriter()
      .on("p", {
        element(el) {
          el.setInnerContent("ok");
        },
      })
      .transform(createResponse("<p>old</p>"));
    assert.equal(await text(res), "<p>ok</p>");
  });

  test("many concurrent async transforms complete without memory corruption", async () => {
    const N = 10;
    const promises = [];
    for (let i = 0; i < N; i++) {
      const rw = new HTMLRewriter().on("span", {
        async element(el) {
          await new Promise((r) => setTimeout(r, Math.random() * 20));
          el.setInnerContent(String(i));
        },
      });
      promises.push(
        text(rw.transform(createResponse(`<span>${i}</span>`))),
      );
    }
    const results = await Promise.all(promises);
    for (let i = 0; i < N; i++) {
      assert.equal(results[i], `<span>${i}</span>`);
    }
  });

  test("concurrent transforms with mixed sync and async handlers", async () => {
    const syncRw = new HTMLRewriter().on("b", {
      element(el) {
        el.setInnerContent("sync");
      },
    });
    const asyncRw = new HTMLRewriter().on("i", {
      async element(el) {
        await new Promise((r) => setTimeout(r, 15));
        el.setInnerContent("async");
      },
    });
    const [syncResult, asyncResult] = await Promise.all([
      text(syncRw.transform(createResponse("<b>old</b>"))),
      text(asyncRw.transform(createResponse("<i>old</i>"))),
    ]);
    assert.equal(syncResult, "<b>sync</b>");
    assert.equal(asyncResult, "<i>async</i>");
  });

  test("error in one concurrent transform does not affect the other", async () => {
    const failing = new HTMLRewriter().on("div", {
      async element() {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("concurrent-fail");
      },
    });
    const passing = new HTMLRewriter().on("p", {
      async element(el) {
        await new Promise((r) => setTimeout(r, 10));
        el.setInnerContent("ok");
      },
    });
    const [failResult, passResult] = await Promise.allSettled([
      text(failing.transform(createResponse("<div>x</div>"))),
      text(passing.transform(createResponse("<p>old</p>"))),
    ]);
    assert.equal(failResult.status, "rejected");
    assert.ok(failResult.reason.message.includes("concurrent-fail"));
    assert.equal(passResult.status, "fulfilled");
    assert.equal(passResult.value, "<p>ok</p>");
  });

  test("reuse of HTMLRewriter instance after a failed transform", async () => {
    let shouldFail = true;
    const rw = new HTMLRewriter().on("div", {
      async element(el) {
        await new Promise((r) => setTimeout(r, 5));
        if (shouldFail) throw new Error("first-fail");
        el.setInnerContent("success");
      },
    });
    // First transform fails.
    await assert.rejects(
      text(rw.transform(createResponse("<div>a</div>"))),
    );
    // Second transform with same instance succeeds.
    shouldFail = false;
    const result = await text(rw.transform(createResponse("<div>b</div>")));
    assert.equal(result, "<div>success</div>");
  });
});