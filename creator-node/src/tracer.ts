import type {
  Span,
  SpanContext,
  SpanOptions,
  AttributeValue,
  Tracer
  // eslint-disable-next-line node/no-extraneous-import
} from '@opentelemetry/api'

import { trace, context, SpanStatusCode } from '@opentelemetry/api'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { Resource } from '@opentelemetry/resources'
import {
  SemanticAttributes,
  SemanticResourceAttributes as ResourceAttributesSC
} from '@opentelemetry/semantic-conventions'
import { FsInstrumentation } from '@opentelemetry/instrumentation-fs'
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { BunyanInstrumentation } from '@opentelemetry/instrumentation-bunyan'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis'

import config from './config'

const SERVICE_NAME = 'content-node'
const SPID = config.get('spID')
const ENDPOINT = config.get('creatorNodeEndpoint')

const TRACING_ENABLED = config.get('otelTracingEnabled')
const COLLECTOR_URL = config.get('otelCollectorUrl')

/**
 * Initializes a tracer for content node as well as registers instrumentions
 * for packages that are frequently used
 * WARNING: this function should be run before any other imports
 * i.e.
 * ```
 * import { setupTracing } from './tracer'
 * setupTracing()
 * // all other imports
 * import { foo } from 'bar'
 * import { isEven } from 'pg'
 * ```
 */
export const setupTracing = () => {
  // If tracing isn't enabled, we don't set up the trace provider
  // or register any instrumentations. This won't cause any errors
  // as methods like `span.startActiveTrace()` or `tracing.recordException()`
  // will just silently do nothing.
  if (!TRACING_ENABLED) return

  /**
   * A Tracer Provider is a factory for Tracers.
   * A Tracer Provider is initialized once and its lifecycle matches the application’s lifecycle.
   * Tracer Provider initialization also includes Resource and Exporter initialization.
   * It is typically the first step in tracing with OpenTelemetry.
   */
  const provider = new NodeTracerProvider({
    resource: new Resource({
      [ResourceAttributesSC.SERVICE_NAME]: SERVICE_NAME
    })
  })

  // Initialize the OpenTelemetry APIs to use the NodeTracerProvider bindings
  provider.register()

  /**
   * prebuilt tracing instrumentations are registered
   * in order to add trace information and context to
   * commonly used library
   *
   * e.g. `ExpressInstrumention()` monkey-patches express routes and middlewares
   * with spans
   */
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      // Express instrumentation expects HTTP layer to be instrumented
      // This reads and writes the appropriate opentelemetry headers to requests
      new HttpInstrumentation(),

      // Adds spans to express routes
      new ExpressInstrumentation(),

      // Adds spans to redis operations
      new IORedisInstrumentation({}),

      // Adds spans to filesystem operatioons
      new FsInstrumentation(),

      // Injects traceid, spanid, and SpanContext into bunyan logs
      new BunyanInstrumentation({
        // Adds a hook to logs that injects more span info
        // and the service name into logs
        logHook: (span, record) => {
          // @ts-ignore
          record['resource.span.name'] = span.name
          // @ts-ignore
          record['resource.span.links'] = span.links
          // @ts-ignore
          record['resource.span.attributed'] = span.attributes
          record['resource.service.name'] =
            provider.resource.attributes['service.name']
          record['resource.service.spid'] = SPID
          record['resource.service.endpoint'] = ENDPOINT

          const logLevel = record.logLevel || 'debug'
          if (logLevel !== 'debug') {
            span.addEvent(record.msg, record)
          }
        }
      })
    ]
  })

  const exporter = new OTLPTraceExporter({
    url: COLLECTOR_URL
  })
  provider.addSpanProcessor(new BatchSpanProcessor(exporter))
}

/**
 * Higher-order function that adds opentelemetry tracing to a function.
 * This wrapper works for both sync and async functions
 *
 * @param {string?} param.name optional name to give to the span, defaults to the function name
 * @param {Object?} param.context optional object context to get wrapped, useful when wrapping non-static methods to classes
 * @param {TFunction} param.fn the generic function to instrument
 * @param {SpanOptions?} param.options objects to pass into the span
 * @returns the instrumented function
 * @throws rethrows any errors from the original fn
 *
 * Usage of this would look like
 * ```
 * const someFunction = instrumentTracing({ fn: _someFunction })
 * const result = someFunction(args))
 * // or
 * const result = await someFunction(args)
 * ```
 */
export const instrumentTracing = <TFunction extends (...args: any[]) => any>({
  name,
  context,
  fn,
  options
}: {
  name?: string
  context?: Object
  fn: TFunction
  options?: SpanOptions
}) => {
  const objectContext = context || this

  // build a wrapper around `fn` that accepts the same parameters and returns the same return type
  const wrapper = function (
    ...args: Parameters<TFunction>
  ): ReturnType<TFunction> {
    const spanName = name || fn.name
    const spanOptions = options || {}
    return tracing
      .getTracer()
      .startActiveSpan(spanName, spanOptions, (span: Span) => {
        try {
          tracing.setSpanAttribute(tracing.CODE_FUNCTION, fn.name)
          tracing.setSpanAttribute('spid', SPID)
          tracing.setSpanAttribute('endpoint', ENDPOINT)

          // TODO add skip parameter to instrument testing function to NOT log certain args
          // tracing.setSpanAttribute('args', JSON.stringify(args))
          const result = fn.apply(objectContext, args)

          // if `fn` is async, await the result
          if (result && result.then) {
            /**
             * by handling promise like this, the caller to this wrapper
             * can still use normal async/await syntax to `await` the result
             * of this wrapper
             * i.e. `const output = await instrumentTracing({ fn: _someFunction })(args)`
             *
             * based on this package: https://github.com/klny/function-wrapper/blob/master/src/wrapper.js#L25
             */
            return result.then((val: any) => {
              span.end()
              return val
            })
          }

          span.end()

          // re-return result from synchronous function
          return result
        } catch (e: any) {
          tracing.recordException(e)
          span.end()

          // rethrow any errors
          throw e
        }
      })
  }
  // copy function name
  Object.defineProperty(wrapper, 'name', { value: fn.name })
  return wrapper
}

/**
 * Namespace to store tracing helper function
 */
export const tracing = {
  CODE_FILEPATH: SemanticAttributes.CODE_FILEPATH,
  CODE_FUNCTION: SemanticAttributes.CODE_FUNCTION,
  SpanStatusCode: SpanStatusCode,

  /**
   * A Tracer creates spans containing more information about what is happening
   * for a given operation, such as a request in a service.
   * Tracers are created from Tracer Providers.
   *
   * This function fetches the tracer from the application context
   * @returns {Tracer} the tracer for content node
   */
  getTracer: (): Tracer => {
    return trace.getTracer(SERVICE_NAME)
  },

  /**
   * @returns {Span | undefined} the current active span or `undefined` if there is no active span
   */
  getActiveSpan: (): Span | undefined => {
    return trace.getSpan(context.active())
  },

  /**
   * Adds a key-value style attribute to the current span
   * @param name the attribute key
   * @param value the attribute value
   */
  setSpanAttribute: (name: string, value: AttributeValue) => {
    const span = tracing.getActiveSpan()
    span?.setAttribute(name, value)
  },

  /**
   * log a message with severity 'debug' on the current span
   * @param {string} msg the message to log
   */
  debug: (msg: string) => {
    const span = tracing.getActiveSpan()
    span?.addEvent(msg, {
      'log.severity': 'debug'
    })
  },

  /**
   * log a message with severity 'info' on the current span
   * @param {string} msg the message to log
   */
  info: (msg: string) => {
    const span = tracing.getActiveSpan()
    span?.addEvent(msg, {
      'log.severity': 'info'
    })
  },

  /**
   * log a message with severity 'warn' on the current span
   * @param {string} msg the message to log
   */
  warn: (msg: string) => {
    const span = tracing.getActiveSpan()
    span?.addEvent(msg, {
      'log.severity': 'warn'
    })
  },

  /**
   * log a message with severity 'error' on the current span
   * @param {string} msg the message to log
   */
  error: (msg: string) => {
    const span = tracing.getActiveSpan()
    span?.setStatus({ code: SpanStatusCode.ERROR, message: msg })
    span?.addEvent(msg, {
      'log.severity': 'error'
    })
  },

  /**
   * records errors on the current trace and sets the span status to `ERROR`
   * @param {Error} error the error to record on the span
   *
   * Usage
   * ```
   * try {
   *     someSketchyCode()
   * } catch (e: any) {
   *     tracing.recordException(e)
   *     throw e
   * }
   * ```
   */
  recordException: (error: Error) => {
    const span = tracing.getActiveSpan()
    span?.recordException(error)
    span?.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
  },

  /**
   * Fetches the current span context if in an active span
   * @returns {SpanContext | undefined} the current span context if in a span
   */
  currentSpanContext: (): SpanContext | undefined => {
    const span = tracing.getActiveSpan()
    return span?.spanContext()
  }
}

module.exports = {
  setupTracing,
  instrumentTracing,
  tracing
}
