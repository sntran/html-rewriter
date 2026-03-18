let CoreRewriter, CoreElement;

// Detect if JSPI is available (Node.js >= v21 with --experimental-wasm-jspi)
const hasJSPI = typeof WebAssembly !== "undefined" &&
  typeof WebAssembly.Suspending === "function" &&
  typeof WebAssembly.promising === "function";

// ---------------------------------------------------------------------------
// JSPI Patch — Intercept WebAssembly.Instance before @sntran/lol-html loads
// ---------------------------------------------------------------------------
// The lol-html WASM glue (lol_html.js) calls user-supplied handler callbacks
// through a `__wbg_call_*` import, wrapping `Function.prototype.call` in
// `handleError`.  When a handler is async the return value is a Promise that
// the synchronous glue code silently ignores.
//
// We use the V8 JSPI (JavaScript Promise Integration) to make this work:
//
//   1. Wrap `__wbg_call_*` imports with `WebAssembly.Suspending` so the WASM
//      stack suspends when a handler returns a Promise.
//   2. Wrap `htmlrewriter_write` / `htmlrewriter_end` exports with
//      `WebAssembly.promising` so they return Promises to JS.
//   3. Capture the Promises returned by the promising-wrapped exports
//      (which the JS glue code drops) and expose them so our `write()`
//      and `end()` wrappers can `await` them.
// ---------------------------------------------------------------------------
if (hasJSPI) {
  // --- JSPI Patch: enable async handlers ---
  const OriginalInstance = WebAssembly.Instance;
  /**
   * Most recent Promise returned by the promising-wrapped WASM exports.
   * The glue code's `write()` / `end()` JS methods drop these return values,
   * so we capture them via a Proxy to make them awaitable.
   */
  let _pendingPromise = null;
  WebAssembly.Instance = function JSPIInstance(module, importObject) {
    if (!importObject) {
      return new OriginalInstance(module, importObject);
    }

    /**
     * A reference to the WebAssembly import object placeholder used by wasm-bindgen.
     *
     * In this context, `importObject['__wbindgen_placeholder__']` is used instead of a specific module path
     * (like `importObject['./lol_html_bg.js']`) because wasm-bindgen generates a placeholder property
     * (`__wbindgen_placeholder__`) to collect all imports required by the generated WebAssembly module.
     * This allows the loader to inject the actual imports at runtime, making the code more flexible and
     * compatible with different bundlers or environments.
     *
     * @type {Object}
     */
    const bindgenImports = importObject["__wbindgen_placeholder__"];
    if (!bindgenImports) {
      return new OriginalInstance(module, importObject);
    }

    // --- Wrap __wbg_call_* imports with Suspending ---
    for (const name of Object.keys(bindgenImports)) {
      if (name.startsWith("__wbg_call_")) {
        const original = bindgenImports[name];
        // IMPORTANT: Use a regular function, NOT async. An async function
        // always wraps its return value in a Promise, which would cause
        // Suspending to attempt suspension even for synchronous results.
        // That triggers "SuspendError: trying to suspend without
        // WebAssembly.promising" when called from non-promising exports
        // (e.g. documentend_append invoked from an async end handler).
        //
        // With a regular function, non-Promise results pass through
        // without suspension, while Promise results (from async handlers)
        // correctly trigger JSPI stack suspension.
        bindgenImports[name] = new WebAssembly.Suspending(
          function () {
            return original.apply(this, arguments);
          },
        );
      }
    }

    // Construct the real instance.
    const instance = new OriginalInstance(module, importObject);

    // --- Wrap selected WASM exports with promising ---
    // Exports that drive handler invocation (htmlrewriter_write/end) must be
    // wrapped with WebAssembly.promising so the WASM stack can suspend when
    // a Suspending-wrapped import (__wbg_call_*) encounters a Promise.
    //
    // Additionally, exports that may be called FROM WITHIN async handlers and
    // that internally invoke __wbg_call_* (e.g. documentend_append flushes
    // output through the output sink callback) also need promising wrappers.
    // Without this, V8 throws "SuspendError: trying to suspend without
    // WebAssembly.promising" even when the Suspending import would not
    // actually suspend.
    //
    // Memory-management exports (__wbindgen_malloc, etc.) must NOT be wrapped
    // because the glue code expects synchronous return values from them.
    const rawExports = instance.exports;
    const wrapped = Object.create(null);

    /** Exports whose Promises must be captured for the async write/end wrappers. */
    const _captureSet = new Set(["htmlrewriter_write", "htmlrewriter_end"]);

    /** Exports that may be called from async handlers and invoke __wbg_call_*. */
    const _promisingSet = new Set([
      "htmlrewriter_write",
      "htmlrewriter_end",
      "documentend_append",
      "endtag_before",
      "endtag_after",
      "endtag_replace",
      "endtag_remove",
      "comment_before",
      "comment_after",
      "comment_replace",
      "comment_remove",
      "textchunk_before",
      "textchunk_after",
      "textchunk_replace",
      "textchunk_remove",
      "element_before",
      "element_after",
      "element_prepend",
      "element_append",
      "element_replace",
      "element_remove",
      "element_removeAndKeepContent",
      "element_setInnerContent",
      "element_setAttribute",
      "element_removeAttribute",
      "element_set_tag_name",
      "element_onEndTag",
    ]);

    for (const name of Object.getOwnPropertyNames(rawExports)) {
      const value = rawExports[name];
      if (typeof value === "function" && _promisingSet.has(name)) {
        const promised = WebAssembly.promising(value);
        if (_captureSet.has(name)) {
          // Capture the Promise so our async write()/end() can await it.
          wrapped[name] = function (...args) {
            const p = promised.apply(this, args);
            _pendingPromise = p;
            return p;
          };
        } else {
          wrapped[name] = promised;
        }
      } else {
        wrapped[name] = value;
      }
    }

    return new Proxy(instance, {
      get(target, prop) {
        if (prop === "exports") return wrapped;
        return Reflect.get(target, prop);
      },
    });
  };

  // ---------------------------------------------------------------------------
  // Import the core rewriter (triggers WASM instantiation with our patch).
  // ---------------------------------------------------------------------------
  ({
    HTMLRewriter: CoreRewriter,
    Element: CoreElement,
  } = await import("@sntran/lol-html"));

  // Restore the original constructor.
  WebAssembly.Instance = OriginalInstance;

  // ---------------------------------------------------------------------------
  // Patch Element.prototype.attributes for Cloudflare API compatibility.
  // ---------------------------------------------------------------------------
  // The `lol-html` library returns attributes as an array of { name, value }
  // objects.  The Cloudflare HTMLRewriter API specifies that Element.attributes
  // is an IterableIterator<[string, string]> yielding [name, value] tuples.
  // We patch the getter to convert the format.

  const _origAttributesDescriptor = Object.getOwnPropertyDescriptor(
    CoreElement.prototype,
    "attributes",
  );

  if (_origAttributesDescriptor && _origAttributesDescriptor.get) {
    Object.defineProperty(CoreElement.prototype, "attributes", {
      get() {
        const rawAttrs = _origAttributesDescriptor.get.call(this);
        return rawAttrs.map((a) => [a.name, a.value]);
      },
      configurable: true,
    });
  }

  // ---------------------------------------------------------------------------
  // Patch CoreRewriter write() / end() / free() to be async-aware and
  // serialized across all instances.
  // ---------------------------------------------------------------------------
  // The glue code's write() / end() methods call the WASM exports synchronously
  // and drop the return value.  With our promising-wrapper, the WASM export
  // returns a Promise that gets captured in `_pendingPromise`.  We override the
  // prototype methods to await that Promise after the original call returns.
  //
  // Because all CoreRewriter instances share the same WASM linear memory, we
  // must serialize every WASM entry point (write / end / free) through a global
  // promise queue.  Without this, two concurrent `#pump` loops (e.g. chained
  // `transform()` calls) can interleave WASM stack operations via JSPI,
  // corrupting the allocator and causing "memory access out of bounds".

  const _origWrite = CoreRewriter.prototype.write;
  const _origEnd = CoreRewriter.prototype.end;
  const _origFree = CoreRewriter.prototype.free;

  /** Global promise queue — ensures only one WASM call is in-flight at a time. */
  let _wasmQueue = Promise.resolve();

  CoreRewriter.prototype.write = async function asyncWrite(chunk) {
    // Create the task promise that the caller will await (preserves errors).
    const task = _wasmQueue.then(async () => {
      _pendingPromise = null;
      _origWrite.call(this, chunk);
      if (_pendingPromise) {
        await _pendingPromise;
        _pendingPromise = null;
      }
    });
    // Advance the queue regardless of success/failure so subsequent
    // operations are not poisoned by a prior rejection.
    _wasmQueue = task.catch(() => {});
    // Caller sees the original error (if any).
    await task;
  };

  CoreRewriter.prototype.end = async function asyncEnd() {
    const task = _wasmQueue.then(async () => {
      _pendingPromise = null;
      _origEnd.call(this);
      if (_pendingPromise) {
        await _pendingPromise;
        _pendingPromise = null;
      }
    });
    _wasmQueue = task.catch(() => {});
    await task;
  };

  CoreRewriter.prototype.free = function queuedFree() {
    // Queue the free so it never runs while another instance is mid-WASM-call.
    // Callers (e.g. #pump's finally block) do not await this — that is fine
    // because the queue guarantees ordering and the free cannot fail in a way
    // that matters to the caller (errors are already swallowed).
    _wasmQueue = _wasmQueue.then(() => {
      _origFree.call(this);
    }).catch(() => {});
  };
} else {
  // ---------------------------------------------------------------------------
  // No JSPI: only sync handlers are supported
  // ---------------------------------------------------------------------------
  ({ HTMLRewriter: CoreRewriter, Element: CoreElement } = await import(
    "@sntran/lol-html"
  ));

  // Patch Element.prototype.attributes for Cloudflare API compatibility
  const _origAttributesDescriptor = Object.getOwnPropertyDescriptor(
    CoreElement.prototype,
    "attributes",
  );
  if (_origAttributesDescriptor && _origAttributesDescriptor.get) {
    Object.defineProperty(CoreElement.prototype, "attributes", {
      get() {
        const rawAttrs = _origAttributesDescriptor.get.call(this);
        return rawAttrs.map((a) => [a.name, a.value]);
      },
      configurable: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Cloudflare-Compatible HTMLRewriter
// ---------------------------------------------------------------------------

/**
 * @typedef {import("@sntran/lol-html").Doctype} Doctype
 */

/**
 * @typedef {import("@sntran/lol-html").Element} Element
 */

/**
 * @typedef {import("@sntran/lol-html").Comment} Comment
 */

/**
 * @typedef {import("@sntran/lol-html").TextChunk} TextChunk
 */

/**
 * @callback doctype
 * @param   {Doctype} doctype
 * @returns {void | Promise<void>}
 */

/**
 * @callback element
 * @param   {Element} element
 * @returns {void | Promise<void>}
 */

/**
 * @callback comments
 * @param   {comment} comment
 * @returns {void | Promise<void>}
 */

/**
 * @callback text
 * @param   {TextChunk} text
 * @returns {void | Promise<void>}
 */

/**
 * @typedef  {Object} DocumentHandlers
 * @property {doctype} [doctype]
 * @property {element} [element]
 * @property {comments} [comments]
 * @property {text} [text]
 */

/**
 * @typedef  {Object} ElementHandlers
 * @property {element} [element]
 * @property {comments} [comments]
 * @property {text} [text]
 */

/**
 * An API for traversing and transforming HTML documents.
 *
 * Example:
 *
 * ```ts
 * import { HTMLRewriter } from "./mod.js";
 *
 * const rewriter = new HTMLRewriter();
 * rewriter.on("img, iframe", {
 *   element(element) {
 *     if (!element.hasAttribute("loading")) {
 *       element.setAttribute("loading", "lazy");
 *     }
 *   },
 * });
 * rewriter.transform(await fetch("https://example.com"));
 * ```
 */
export class HTMLRewriter {
  /** @type {Array<{selector: string, handlers: ElementHandlers}>} */
  #elementHandlers = [];
  /** @type {Array<DocumentHandlers>} */
  #documentHandlers = [];

  /**
   * Register element content handlers for a CSS selector.
   * @param {string} selector
   * @param {ElementHandlers} handlers
   * @returns {HTMLRewriter}
   */
  on(selector, handlers) {
    if (!hasJSPI) {
      // Check for async handlers in sync-only mode
      for (const key of Object.keys(handlers)) {
        if (
          typeof handlers[key] === "function" &&
          handlers[key].constructor.name === "AsyncFunction"
        ) {
          throw new Error(
            "Async handlers are not supported in this environment. Start Node.js with --experimental-wasm-jspi to enable async handlers.",
          );
        }
      }
    }
    this.#elementHandlers.push({ selector, handlers });
    return this;
  }

  /**
   * Register document content handlers.
   * @param {DocumentHandlers} handlers
   * @returns {HTMLRewriter}
   */
  onDocument(handlers) {
    if (!hasJSPI) {
      for (const key of Object.keys(handlers)) {
        if (
          typeof handlers[key] === "function" &&
          handlers[key].constructor.name === "AsyncFunction"
        ) {
          throw new Error(
            "Async handlers are not supported in this environment. Start Node.js with --experimental-wasm-jspi to enable async handlers.",
          );
        }
      }
    }
    this.#documentHandlers.push(handlers);
    return this;
  }

  /**
   * Transform a Response by streaming its body through the lol-html engine.
   * @param {Response} response
   * @returns {Response}
   */
  transform(response) {
    const headers = new Headers(response.headers);
    headers.delete("Content-Length");

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    /**
     * @type {import('@sntran/lol-html').HTMLRewriter}
     */
    const core = new CoreRewriter("utf8", (chunk) => {
      if (chunk.length !== 0) {
        writer.write(chunk);
      }
    });

    for (const { selector, handlers } of this.#elementHandlers) {
      core.on(selector, handlers);
    }
    for (const handlers of this.#documentHandlers) {
      core.onDocument(handlers);
    }

    this.#pump(response.body, core, writer);

    return new Response(readable, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  /**
   * @param {ReadableStream | null} body
   * @param {import('@sntran/lol-html').HTMLRewriter} core
   * @param {WritableStreamDefaultWriter} writer
   */
  async #pump(body, core, writer) {
    try {
      if (body) {
        const reader = body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await core.write(value);
        }
      }
      await core.end();
      writer.close();
    } catch (err) {
      writer.abort(err);
    } finally {
      try {
        core.free();
      } catch (_) {
        // Ignore double-free or errors from a poisoned rewriter state.
        // This can happen when a handler error corrupts the WASM parser
        // and the subsequent free() hits a Rust borrow violation.
      }
    }
  }
}
