/**
 * Minimal fake Cordis context for offline plugin tests.
 *
 * Implements just enough of the Context surface the plugin touches: named
 * loggers, `effect`, `on`/`emit`, lazy `get`, and `inject`. Services the plugin
 * looks up (`tools`, `agents`, `sessionController`) are injected by the caller.
 */

/** Collects log lines and forwards them to stderr. */
export function createLogSink() {
  const lines = []
  const write = (level, args) => {
    const text = `${level.toUpperCase().padEnd(5)} ${args.map((a) => String(a)).join(' ')}`
    lines.push(text)
    process.stderr.write(`${text}\n`)
  }
  return { lines, write }
}

/**
 * Build a fake context.
 * @param options - `services` map, `logSink`, and an optional emit recorder.
 * @returns the context plus test handles.
 */
export function createFakeContext({ services = {}, logSink = createLogSink() } = {}) {
  const listeners = new Map()
  const disposers = []
  const emitted = []
  const registeredTools = []

  const tools = services.tools ?? { register: (tool) => registeredTools.push(tool) }

  function makeLogger() {
    const logger = (...nameParts) => makeLogger(nameParts.join(':'))
    logger.info = (...a) => logSink.write('info', a)
    logger.warn = (...a) => logSink.write('warn', a)
    logger.error = (...a) => logSink.write('error', a)
    logger.debug = (...a) => logSink.write('debug', a)
    return logger
  }

  const resolvedServices = { ...services, tools }

  const ctx = {
    logger: makeLogger(),
    tools,
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(handler)
        if (index >= 0) current.splice(index, 1)
      }
    },
    emit(event, payload) {
      emitted.push({ event, payload })
    },
    get(serviceName) {
      return resolvedServices[serviceName]
    },
    inject(deps, callback) {
      // Real Cordis only runs the callback once every declared service exists,
      // so a plugin can rely on `ctx.<service>` inside it. Mirroring that keeps
      // tests from reporting failures that cannot happen in production.
      const wanted = Array.isArray(deps) ? deps : Object.keys(deps ?? {})
      const missing = wanted.filter((serviceName) => resolvedServices[serviceName] === undefined)
      if (missing.length > 0) {
        logSink.write('debug', [`inject skipped; missing service(s): ${missing.join(', ')}`])
        return
      }
      callback(ctx)
    },
  }

  // Real Cordis exposes every service as a property on the context, and the
  // plugin reads some of them directly (`ctx.systemPrompt`), so mirror them here
  // instead of only supporting `ctx.get(name)`.
  for (const [serviceName, value] of Object.entries(resolvedServices)) {
    if (!(serviceName in ctx)) ctx[serviceName] = value
  }

  return {
    ctx,
    emitted,
    registeredTools,
    logSink,
    /** Invoke every listener registered for one event. */
    async fire(event, payload) {
      for (const handler of listeners.get(event) ?? []) {
        await handler(payload, async () => undefined)
      }
    },
    /**
     * Dispatch a Cordis **waterfall** the way `dsh-user-questions` does: listeners
     * run in registration order, each may return an answer to accept it or call
     * `next()` to pass the request on, and the fallback rejects when nobody
     * accepts.
     *
     * `downstream` models the Web question surface, which registers after this
     * plugin (the browser connects long after boot) and may answer at any time.
     * @param payload - the request.
     * @param options - `downstream(payload) => Promise<answer>`.
     * @returns the first accepted answer.
     */
    async askUserQuestion(payload, { downstream = null } = {}) {
      const chain = [...(listeners.get('user-questions/request') ?? [])]
      const dispatch = async (index) => {
        if (index >= chain.length) {
          if (downstream !== null) return downstream(payload)
          throw new Error('no user-questions answerer accepted the request')
        }
        return chain[index](payload, () => dispatch(index + 1))
      }
      return dispatch(0)
    },
    /** Run every collected disposer in reverse order. */
    async disposeAll() {
      for (const dispose of [...disposers].reverse()) {
        try {
          await dispose()
        } catch (error) {
          logSink.write('warn', [`disposer failed: ${String(error)}`])
        }
      }
    },
  }
}

/** Promise-based sleep. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
