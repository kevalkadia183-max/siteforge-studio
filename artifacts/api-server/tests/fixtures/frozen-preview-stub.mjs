// No-op stub used to alias runtime-only modules (pg, pino, pino-http) that are
// never exercised by the focused frozen-preview tests. Importing the route
// modules constructs a pg Pool and a pino logger at module load; this stub
// satisfies those side effects without pulling in CJS-only / worker-thread
// deps.

function makeChainable() {
  const noop = function () {};
  return new Proxy(noop, {
    get: () => makeChainable(),
    apply: () => makeChainable(),
    construct: () => makeChainable(),
  });
}

// pino default export is a callable factory returning a logger; pg default
// export is an object exposing a `Pool` constructor. A single chainable proxy
// satisfies both shapes (callable, constructable, any property access).
const chainable = makeChainable();

export default chainable;
export const Pool = chainable;
export const drizzle = chainable;
