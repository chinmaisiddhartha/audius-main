const _ = require('lodash')

const config = require('../../../config')
const {
  QUEUE_HISTORY,
  QUEUE_NAMES,
  STATE_MONITORING_QUEUE_INIT_DELAY_MS
} = require('../stateMachineConstants')
const { makeQueue } = require('../stateMachineUtils')
const processJob = require('../processJob')
const { logger: baseLogger, createChildLogger } = require('../../../logging')
const { getLatestUserIdFromDiscovery } = require('./stateMonitoringUtils')
const monitorStateJobProcessor = require('./monitorState.jobProcessor')
const findSyncRequestsJobProcessor = require('./findSyncRequests.jobProcessor')
const findReplicaSetUpdatesJobProcessor = require('./findReplicaSetUpdates.jobProcessor')
const fetchCNodeEndpointToSpIdMapJobProcessor = require('./fetchCNodeEndpointToSpIdMap.jobProcessor')

const monitorStateLogger = createChildLogger(baseLogger, {
  queue: QUEUE_NAMES.MONITOR_STATE
})
const findSyncRequestsLogger = createChildLogger(baseLogger, {
  queue: QUEUE_NAMES.FIND_SYNC_REQUESTS
})
const findReplicaSetUpdatesLogger = createChildLogger(baseLogger, {
  queue: QUEUE_NAMES.FIND_REPLICA_SET_UPDATES
})
const cNodeEndpointToSpIdMapQueueLogger = createChildLogger(baseLogger, {
  queue: QUEUE_NAMES.FETCH_C_NODE_ENDPOINT_TO_SP_ID_MAP
})

/**
 * Handles setup and job processing of the queue with jobs for:
 * - fetching a slice of users and gathering their state
 * - finding syncs that should be issued for users to sync their data from their primary to their secondaries
 * - finding users who need a replica set update (when an unhealthy primary or secondary should be replaced)
 */
class StateMonitoringManager {
  async init(prometheusRegistry) {
    // Create queue to fetch cNodeEndpoint->spId mapping
    const { queue: cNodeEndpointToSpIdMapQueue } = await makeQueue({
      name: QUEUE_NAMES.FETCH_C_NODE_ENDPOINT_TO_SP_ID_MAP,
      processor: this.makeProcessJob(
        fetchCNodeEndpointToSpIdMapJobProcessor,
        cNodeEndpointToSpIdMapQueueLogger,
        prometheusRegistry
      ).bind(this),
      logger: cNodeEndpointToSpIdMapQueueLogger,
      removeOnComplete: QUEUE_HISTORY.FETCH_C_NODE_ENDPOINT_TO_SP_ID_MAP,
      removeOnFail: QUEUE_HISTORY.FETCH_C_NODE_ENDPOINT_TO_SP_ID_MAP,
      prometheusRegistry,
      limiter: {
        max: 1,
        duration: config.get('fetchCNodeEndpointToSpIdMapIntervalMs')
      }
    })

    // Create queue to slice through batches of users and gather data to be passed to find-sync and find-replica-set-update jobs
    const { queue: monitorStateQueue } = await makeQueue({
      name: QUEUE_NAMES.MONITOR_STATE,
      processor: this.makeProcessJob(
        monitorStateJobProcessor,
        monitorStateLogger,
        prometheusRegistry
      ).bind(this),
      logger: monitorStateLogger,
      removeOnComplete: QUEUE_HISTORY.MONITOR_STATE,
      removeOnFail: QUEUE_HISTORY.MONITOR_STATE,
      prometheusRegistry,
      limiter: {
        // Bull doesn't allow either of these to be set to 0, so we'll pause the queue later if the jobs per interval is 0
        max: config.get('stateMonitoringQueueRateLimitJobsPerInterval') || 1,
        duration: config.get('stateMonitoringQueueRateLimitInterval') || 1
      }
    })

    // Create queue to find sync requests
    const { queue: findSyncRequestsQueue } = await makeQueue({
      name: QUEUE_NAMES.FIND_SYNC_REQUESTS,
      processor: this.makeProcessJob(
        findSyncRequestsJobProcessor,
        findSyncRequestsLogger,
        prometheusRegistry
      ).bind(this),
      logger: findSyncRequestsLogger,
      removeOnComplete: QUEUE_HISTORY.FIND_SYNC_REQUESTS,
      removeOnFail: QUEUE_HISTORY.FIND_SYNC_REQUESTS,
      prometheusRegistry
    })

    // Create queue to find replica set updates
    const { queue: findReplicaSetUpdatesQueue } = await makeQueue({
      name: QUEUE_NAMES.FIND_REPLICA_SET_UPDATES,
      processor: this.makeProcessJob(
        findReplicaSetUpdatesJobProcessor,
        findReplicaSetUpdatesLogger,
        prometheusRegistry
      ).bind(this),
      logger: findReplicaSetUpdatesLogger,
      removeOnComplete: QUEUE_HISTORY.FIND_REPLICA_SET_UPDATES,
      removeOnFail: QUEUE_HISTORY.FIND_REPLICA_SET_UPDATES,
      prometheusRegistry
    })

    return {
      monitorStateQueue,
      findSyncRequestsQueue,
      findReplicaSetUpdatesQueue,
      cNodeEndpointToSpIdMapQueue
    }
  }

  /**
   * Enqueues a job that starts at a random user.
   * Bull's onError doesn't pass in the previous job's info so there's no way to know where it left off.
   * Otherwise this should start where the failed job left off
   * @param monitoringQueue the queue to re-add the job to
   */
  async recoverFromJobFailure(monitoringQueue, discoveryNodeEndpoint) {
    const latestUserId = await getLatestUserIdFromDiscovery(
      discoveryNodeEndpoint
    )
    const lastProcessedUserId = _.random(0, latestUserId)

    monitoringQueue.add('retry-after-fail', {
      lastProcessedUserId,
      discoveryNodeEndpoint
    })
  }

  /**
   * Adds a job that will start processing users
   * starting from a random userId. Future jobs are added to the queue as a
   * result of this initial job succeeding or failing to complete.
   * @param {Object} queue the StateMonitoringQueue to consume jobs from
   * @param {string} discoveryNodeEndpoint the IP address or URL of a Discovery Node
   */
  async startMonitorStateQueue(queue, discoveryNodeEndpoint) {
    // Since we can't pass 0 to Bull's limiter.max, enforce a rate limit of 0 by
    // pausing the queue and not enqueuing the first job
    if (config.get('stateMonitoringQueueRateLimitJobsPerInterval') === 0) {
      await queue.pause()
      return
    }

    // Start at a random userId to avoid biased processing of early users
    const latestUserId = await getLatestUserIdFromDiscovery(
      discoveryNodeEndpoint
    )
    const lastProcessedUserId = _.random(0, latestUserId)

    // Enqueue first monitorState job after a delay. This job requeues itself upon completion or failure
    await queue.add(
      'first-job',
      {
        lastProcessedUserId,
        discoveryNodeEndpoint
      },
      { delay: STATE_MONITORING_QUEUE_INIT_DELAY_MS }
    )
  }

  /**
   * Adds an initial job to the cNodeEndpoint->spId map queue.
   * Future jobs are added to the queue as a result of this initial job succeeding/failing.
   * @param {Object} queue the cNodeEndpoint->spId map queue to consume jobs from
   * @param {Object} prometheusRegistry the registry of metrics from src/services/prometheusMonitoring/prometheusRegistry.js
   */
  async startEndpointToSpIdMapQueue(queue) {
    // Since we can't pass 0 to Bull's limiter.max, enforce a rate limit of 0 by
    // pausing the queue and not enqueuing the first job
    if (config.get('stateMonitoringQueueRateLimitJobsPerInterval') === 0) {
      await queue.pause()
      return
    }

    // Enqueue first job, which requeues itself upon completion or failure
    await queue.add('first-job', {})
  }

  makeProcessJob(processor, logger, prometheusRegistry) {
    return async (job) => processJob(job, processor, logger, prometheusRegistry)
  }
}

module.exports = StateMonitoringManager
