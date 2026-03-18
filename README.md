# HTMLRewriter

Provides the same HTMLRewriter for all platforms.

## Platform Support and Async Handlers

**Async handler support requires Node.js v24+ or Deno v2.4.0+ with the
`--experimental-wasm-jspi` flag.**

- **Node.js:** If you use async handler functions (e.g.,
  `async element() { ... }`), you must run your code with Node.js 24 or newer
  and the `--experimental-wasm-jspi` flag enabled:

  ```
  node --experimental-wasm-jspi your-script.js
  ```

- **Deno:** Deno 2.4.0+ also supports this flag:

  ```
  deno run --unstable --experimental-wasm-jspi your-script.ts
  ```

- **Bun and Cloudflare Workers:** These platforms already provide a native
  `HTMLRewriter` implementation. You do **not** need this flag, and async
  handlers are supported out of the box.

If you do not use this flag in Node.js or Deno, only synchronous handlers are
supported. Registering an async handler without JSPI will throw an error at
registration time.

## Examples

### Rewrite URL links in HTML

```js
import { HTMLRewriter } from "@sntran/html-rewriter";

export default {
  async fetch(request) {
    const OLD_URL = "developer.mozilla.org";
    const NEW_URL = "mynewdomain.com";

    class AttributeRewriter {
      constructor(attributeName) {
        this.attributeName = attributeName;
      }
      element(element) {
        const attribute = element.getAttribute(this.attributeName);
        if (attribute) {
          element.setAttribute(
            this.attributeName,
            attribute.replace(OLD_URL, NEW_URL),
          );
        }
      }
    }

    const rewriter = new HTMLRewriter()
      .on("a", new AttributeRewriter("href"))
      .on("img", new AttributeRewriter("src"));

    const res = await fetch(request);
    const contentType = res.headers.get("Content-Type");

    // If the response is HTML, it can be transformed with
    // HTMLRewriter -- otherwise, it should pass through
    if (contentType.startsWith("text/html")) {
      return rewriter.transform(res);
    } else {
      return res;
    }
  },
};
```

### Async handler example

You can use async handlers to fetch data or perform asynchronous operations
during rewriting:

```js
import { HTMLRewriter } from "@sntran/html-rewriter";

export default {
  async fetch(request) {
    const rewriter = new HTMLRewriter()
      .on("#user", {
        async element(el) {
          // Simulate async data fetch
          const user = await fetchUser();
          el.setInnerContent(`User: ${user.name}`);
        },
      });

    const res = await fetch(request);
    return rewriter.transform(res);
  },
};

// Example async function
async function fetchUser() {
  // Replace with your actual async logic
  await new Promise((r) => setTimeout(r, 100));
  return { name: "Alice" };
}
```
