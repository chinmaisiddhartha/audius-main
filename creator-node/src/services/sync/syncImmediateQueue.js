const { Queue, QueueEvents, Worker } = require('bullmq')

const {
  clusterUtilsForWorker,
  clearActiveJobs,
  getConcurrencyPerWorker
} = require('../../utils')
const { instrumentTracing, tracing } = require('../../tracer')
const {
  logger,
  logInfoWithDuration,
  logErrorWithDuration,
  getStartTime
} = require('../../logging')
const { secondarySyncFromPrimary } = require('./secondarySyncFromPrimary')

const SYNC_QUEUE_HISTORY = 500

/**
 * SyncImmediateQueue - handles enqueuing and processing of immediate manual Sync jobs on secondary
 * sync job = this node (secondary) will sync data for a user from their primary
 * this queue is only for manual immediate syncs which are awaited until they're finished, for regular
 * syncs look at SyncQueue
 */
class SyncImmediateQueue {
  /**
   * Construct bull queue and define job processor
   * @notice - accepts `serviceRegistry` instance, even though this class is initialized
   *    in that serviceRegistry instance. A sub-optimal workaround for now.
   */
  async init(nodeConfig, redis, serviceRegistry) {
    this.nodeConfig = nodeConfig
    this.redis = redis
    this.serviceRegistry = serviceRegistry

    const connection = {
      host: nodeConfig.get('redisHost'),
      port: nodeConfig.get('redisPort')
    }
    this.queue = new Queue('sync-immediate-processing-queue', {
      connection,
      defaultJobOptions: {
        removeOnComplete: SYNC_QUEUE_HISTORY,
        removeOnFail: SYNC_QUEUE_HISTORY
      }
    })
    this.queueEvents = new QueueEvents('sync-immediate-processing-queue', {
      connection
    })

    // any leftover active jobs need to be deleted when a new queue
    // is created since they'll never get processed
    if (clusterUtilsForWorker.isThisWorkerFirst()) {
      await clearActiveJobs(this.queue, logger)
    }

    const worker = new Worker(
      'sync-immediate-processing-queue',
      async (job) => {
        // Get the `parentSpanContext` from the job data
        // so the job can reference what span enqueued it
        const { parentSpanContext } = job.data

        const untracedProcessTask = this.processTask
        const processTask = instrumentTracing({
          name: 'syncImmediateQueue.process',
          fn: untracedProcessTask,
          options: {
            // if a parentSpanContext is provided
            // reference it so the async queue job can remember
            // who enqueued it
            links: parentSpanContext
              ? [
                  {
                    context: parentSpanContext
                  }
                ]
              : [],
            attributes: {
              [tracing.CODE_FILEPATH]: __filename
            }
          }
        })

        // `processTask()` on longer has access to `this` after going through the tracing wrapper
        // so to mitigate that, we're manually adding `this.serviceRegistry` to the job data
        job.data = { ...job.data, serviceRegistry: this.serviceRegistry }
        return await processTask(job)
      },
      {
        connection,
        concurrency: getConcurrencyPerWorker(
          this.nodeConfig.get('syncQueueMaxConcurrency')
        )
      }
    )

    const prometheusRegistry = serviceRegistry?.prometheusRegistry
    if (prometheusRegistry !== null && prometheusRegistry !== undefined) {
      prometheusRegistry.startQueueMetrics(this.queue, worker)
    }
  }

  async processTask(job) {
    const {
      wallet,
      creatorNodeEndpoint,
      forceResyncConfig,
      forceWipe,
      syncOverride,
      logContext,
      serviceRegistry,
      syncUuid
    } = job.data

    const startTime = getStartTime()
    try {
      const result = await secondarySyncFromPrimary({
        serviceRegistry,
        wallet,
        creatorNodeEndpoint,
        forceResyncConfig,
        forceWipe,
        syncOverride,
        logContext,
        syncUuid: syncUuid || null
      })
      logInfoWithDuration(
        { logger, startTime },
        `syncImmediateQueue - secondarySyncFromPrimary Success for wallet ${wallet} from primary ${creatorNodeEndpoint}`
      )
      return result
    } catch (e) {
      logErrorWithDuration(
        { logger, startTime },
        `syncImmediateQueue - secondarySyncFromPrimary Error - failure for wallet ${wallet} from primary ${creatorNodeEndpoint} - ${e.message}`
      )
      throw e
    }
  }

  /**
   * Process a manual sync with immediate: true. This holds the promise open until the job finishes processing and returns the result.
   * It does not return the promise once the job has been added to the queue unlike other queues.
   */
  async processManualImmediateSync({
    wallet,
    creatorNodeEndpoint,
    forceResyncConfig,
    forceWipe,
    syncOverride,
    logContext,
    parentSpanContext,
    syncUuid = null // Could be null for backwards compatibility
  }) {
    const job = await this.queue.add('process-sync-immediate', {
      wallet,
      creatorNodeEndpoint,
      forceResyncConfig,
      forceWipe,
      syncOverride,
      logContext,
      parentSpanContext,
      syncUuid: syncUuid || null
    })
    const result = await job.waitUntilFinished(this.queueEvents)
    return result
  }
}

module.exports = SyncImmediateQueue
