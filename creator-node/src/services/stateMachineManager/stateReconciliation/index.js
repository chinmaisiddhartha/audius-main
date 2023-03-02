const config = require('../../../config')
const { QUEUE_HISTORY, QUEUE_NAMES } = require('../stateMachineConstants')
const { makeQueue } = require('../stateMachineUtils')
const processJob = require('../processJob')
const { logger: baseLogger, createChildLogger } = require('../../../logging')
const handleSyncRequestJobProcessor = require('./issueSyncRequest.jobProcessor')
const updateReplicaSetJobProcessor = require('./updateReplicaSet.jobProcessor')
const {
  default: recoverOrphanedDataJobProcessor
} = require('./recoverOrphanedData.jobProcessor')

const recurringSyncLogger = createChildLogger(baseLogger, {
  queue: QUEUE_NAMES.RECURRING_SYNC
})
const manualSyncLogger = createChildLogger(baseLogger, {
  queue: QUEUE_NAMES.MANUAL_SYNC
})
const updateReplicaSetLogger = createChildLogger(baseLogger, {
  queue: QUEUE_NAMES.UPDATE_REPLICA_SET
})

const recoverOrphanedDataLogger = createChildLogger(baseLogger, {
  queue: QUEUE_NAMES.RECOVER_ORPHANED_DATA
})

/**
 * Handles setup and job processing of the queue with jobs for:
 * - issuing sync requests to nodes (this can be other nodes or this node)
 * - updating user's replica sets when one or more nodes in their replica set becomes unhealthy
 */
class StateReconciliationManager {
  async init(prometheusRegistry) {
    const { queue: manualSyncQueue } = await makeQueue({
      name: QUEUE_NAMES.MANUAL_SYNC,
      processor: this.makeProcessJob(
        handleSyncRequestJobProcessor,
        manualSyncLogger,
        prometheusRegistry
      ).bind(this),
      logger: manualSyncLogger,
      globalConcurrency: config.get('maxManualRequestSyncJobConcurrency'),
      removeOnComplete: QUEUE_HISTORY.MANUAL_SYNC,
      removeOnFail: QUEUE_HISTORY.MANUAL_SYNC,
      prometheusRegistry
    })

    const { queue: recurringSyncQueue } = await makeQueue({
      name: QUEUE_NAMES.RECURRING_SYNC,
      processor: this.makeProcessJob(
        handleSyncRequestJobProcessor,
        recurringSyncLogger,
        prometheusRegistry
      ).bind(this),
      logger: recurringSyncLogger,
      globalConcurrency: config.get('maxRecurringRequestSyncJobConcurrency'),
      removeOnComplete: QUEUE_HISTORY.RECURRING_SYNC,
      removeOnFail: QUEUE_HISTORY.RECURRING_SYNC,
      prometheusRegistry
    })

    if (config.get('maxRecurringRequestSyncJobConcurrency') === 0) {
      await recurringSyncQueue.pause()
    }

    const { queue: updateReplicaSetQueue } = await makeQueue({
      name: QUEUE_NAMES.UPDATE_REPLICA_SET,
      processor: this.makeProcessJob(
        updateReplicaSetJobProcessor,
        updateReplicaSetLogger,
        prometheusRegistry
      ).bind(this),
      logger: updateReplicaSetLogger,
      globalConcurrency: config.get('maxUpdateReplicaSetJobConcurrency'),
      removeOnComplete: QUEUE_HISTORY.UPDATE_REPLICA_SET,
      removeOnFail: QUEUE_HISTORY.UPDATE_REPLICA_SET,
      prometheusRegistry
    })

    if (config.get('maxUpdateReplicaSetJobConcurrency') === 0) {
      await updateReplicaSetQueue.pause()
    }

    const { queue: recoverOrphanedDataQueue } = await makeQueue({
      name: QUEUE_NAMES.RECOVER_ORPHANED_DATA,
      processor: this.makeProcessJob(
        recoverOrphanedDataJobProcessor,
        recoverOrphanedDataLogger,
        prometheusRegistry
      ).bind(this),
      logger: recoverOrphanedDataLogger,
      removeOnComplete: QUEUE_HISTORY.RECOVER_ORPHANED_DATA,
      removeOnFail: QUEUE_HISTORY.RECOVER_ORPHANED_DATA,
      prometheusRegistry,
      limiter: {
        // Bull doesn't allow either of these to be set to 0, so we'll pause the queue later if the jobs per interval is 0
        max:
          config.get('recoverOrphanedDataQueueRateLimitJobsPerInterval') || 1,
        duration: config.get('recoverOrphanedDataQueueRateLimitInterval') || 1
      }
    })

    return {
      manualSyncQueue,
      recurringSyncQueue,
      updateReplicaSetQueue,
      recoverOrphanedDataQueue
    }
  }

  /**
   * Adds a job that will find+reconcile data on nodes outside of a user's replica set.
   * Future jobs are added to the queue as a result of this initial job succeeding or failing to complete.
   * @param {BullQueue} queue the queue that processes jobs to recover orphaned data
   * @param {string} discoveryNodeEndpoint the IP address or URL of a Discovery Node
   */
  async startRecoverOrphanedDataQueue(queue, discoveryNodeEndpoint) {
    // Since we can't pass 0 to Bull's limiter.max, enforce a rate limit of 0 by
    // pausing the queue and not enqueuing the first job
    if (config.get('recoverOrphanedDataQueueRateLimitJobsPerInterval') === 0) {
      await queue.pause()
      return
    }

    // Enqueue first recoverOrphanedData job after a delay. This job requeues itself upon completion or failure
    await queue.add('first-job', { discoveryNodeEndpoint })
  }

  makeProcessJob(processor, logger, prometheusRegistry) {
    return async (job) => processJob(job, processor, logger, prometheusRegistry)
  }
}

module.exports = StateReconciliationManager
