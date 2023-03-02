const _ = require('lodash')
const axios = require('axios')

const redisClient = require('../../../redis')
const { logger } = require('../../../logging')
const Utils = require('../../../utils')
const {
  SyncType,
  SYNC_MODES,
  HEALTHY_SERVICES_TTL_SEC
} = require('../stateMachineConstants')
const SyncRequestDeDuplicator = require('./SyncRequestDeDuplicator')
const { instrumentTracing, tracing } = require('../../../tracer')

const HEALTHY_NODES_CACHE_KEY = 'stateMachineHealthyContentNodes'

/**
 * Returns a job can be enqueued to add a sync request for the given user to the given secondary,
 * or returns the duplicate job if one already exists to for the same user and secondary.
 * @Returns {
 *   duplicateSyncReq,
 *   syncReqToEnqueue
 * }
 */
const getNewOrExistingSyncReq = async ({
  userWallet,
  primaryEndpoint,
  secondaryEndpoint,
  syncType,
  syncMode,
  immediate = false
}) => {
  if (
    !userWallet ||
    !primaryEndpoint ||
    !secondaryEndpoint ||
    !syncType ||
    !syncMode
  ) {
    throw new Error(
      `getNewOrExistingSyncReq missing parameter - userWallet: ${userWallet}, primaryEndpoint: ${primaryEndpoint}, secondaryEndpoint: ${secondaryEndpoint}, syncType: ${syncType}, syncMode: ${syncMode}`
    )
  }
  /**
   * If duplicate sync already exists, do not add and instead return existing sync job info
   * Ignore syncMode when checking for duplicates, since it doesn't matter
   */
  const duplicateSyncJobInfo =
    await SyncRequestDeDuplicator.getDuplicateSyncJobInfo(
      syncType,
      userWallet,
      secondaryEndpoint,
      immediate
    )
  if (duplicateSyncJobInfo) {
    logger.error(
      `getNewOrExistingSyncReq() Failure - a sync of type ${syncType} is already waiting for user wallet ${userWallet} against secondary ${secondaryEndpoint}`
    )

    return {
      duplicateSyncReq: {
        ...duplicateSyncJobInfo,
        parentSpanContext: tracing.currentSpanContext()
      }
    }
  }

  // Define axios params for sync request to secondary
  const syncRequestParameters = {
    baseURL: secondaryEndpoint,
    url: '/sync',
    method: 'post',
    data: {
      wallet: [userWallet],
      creator_node_endpoint: primaryEndpoint,
      // Note - `sync_type` param is only used for logging by nodeSync.js
      sync_type: syncType,
      // immediate = true will ensure secondary skips debounce and evaluates sync immediately
      immediate
    }
  }

  // Add job to issue manual or recurring sync request based on `syncType` param
  const syncReqToEnqueue = {
    syncType,
    syncMode,
    syncRequestParameters,
    parentSpanContext: tracing.currentSpanContext()
  }

  // eslint-disable-next-line node/no-sync
  await SyncRequestDeDuplicator.recordSync(
    syncType,
    userWallet,
    secondaryEndpoint,
    syncReqToEnqueue,
    immediate
  )

  tracing.info(JSON.stringify(syncReqToEnqueue))
  return { syncReqToEnqueue }
}

const getSyncStatusByUuid = async (targetUrl, syncUuid) => {
  const resp = await axios({
    baseURL: targetUrl,
    url: `/sync_status/uuid/${syncUuid}`,
    method: 'get',
    timeout: 30_000
  })
  return resp?.data?.data?.syncStatus
}

/**
 * Issues syncRequest for user against secondary, and polls for replication up to primary
 * If secondary fails to sync within specified timeoutMs, will error
 */
const _issueSyncRequestsUntilSynced = async (
  primaryUrl,
  secondaryUrl,
  wallet,
  primaryClockVal,
  timeoutMs,
  queue
) => {
  // Issue syncRequest before polling secondary for replication
  const { duplicateSyncReq, syncReqToEnqueue } = await getNewOrExistingSyncReq({
    userWallet: wallet,
    secondaryEndpoint: secondaryUrl,
    primaryEndpoint: primaryUrl,
    syncType: SyncType.Manual,
    syncMode: SYNC_MODES.SyncSecondaryFromPrimary,
    immediate: true
  })
  if (!_.isEmpty(duplicateSyncReq)) {
    // Log duplicate and return
    logger.warn(`Duplicate sync request: ${JSON.stringify(duplicateSyncReq)}`)
    return
  } else if (!_.isEmpty(syncReqToEnqueue)) {
    await queue.add('manual-sync', {
      enqueuedBy: 'issueSyncRequestsUntilSynced',
      ...syncReqToEnqueue
    })
  } else {
    // Log error that the sync request couldn't be created and return
    logger.error(`Failed to create manual sync request`)
    return
  }

  // Poll clock status and issue syncRequests until secondary is caught up or until timeoutMs
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      // Retrieve secondary clock status for user
      const secondaryClockStatusResp = await axios({
        method: 'get',
        baseURL: secondaryUrl,
        url: `/users/clock_status/${wallet}`,
        responseType: 'json',
        timeout: 1000 // 1000ms = 1s
      })
      const { clockValue: secondaryClockVal } =
        secondaryClockStatusResp.data.data

      // If secondary is synced, return successfully
      if (secondaryClockVal >= primaryClockVal) {
        return
      }

      // Give secondary some time to process ongoing sync
      // NOTE - we might want to make this timeout longer
      await Utils.timeout(500)
    } catch (e) {
      // do nothing and let while loop continue
    }
  }

  // This condition will only be hit if the secondary has failed to sync within timeoutMs
  throw new Error(
    `Secondary ${secondaryUrl} did not sync up to primary for user ${wallet} within ${timeoutMs}ms`
  )
}

const issueSyncRequestsUntilSynced = instrumentTracing({
  fn: _issueSyncRequestsUntilSynced,
  options: {
    attributes: {
      [tracing.CODE_FILEPATH]: __filename
    }
  }
})

const getCachedHealthyNodes = async () => {
  const healthyNodes = await redisClient.lrange(HEALTHY_NODES_CACHE_KEY, 0, -1)
  return healthyNodes
}

const cacheHealthyNodes = async (healthyNodes) => {
  const pipeline = redisClient.pipeline()
  await pipeline
    .del(HEALTHY_NODES_CACHE_KEY)
    .rpush(HEALTHY_NODES_CACHE_KEY, ...(healthyNodes || []))
    .expire(HEALTHY_NODES_CACHE_KEY, HEALTHY_SERVICES_TTL_SEC)
    .exec()
}

module.exports = {
  getNewOrExistingSyncReq: instrumentTracing({
    fn: getNewOrExistingSyncReq
  }),
  issueSyncRequestsUntilSynced: instrumentTracing({
    fn: issueSyncRequestsUntilSynced
  }),
  getCachedHealthyNodes: instrumentTracing({ fn: getCachedHealthyNodes }),
  cacheHealthyNodes: instrumentTracing({ fn: cacheHealthyNodes }),
  getSyncStatusByUuid: instrumentTracing({ fn: getSyncStatusByUuid })
}
