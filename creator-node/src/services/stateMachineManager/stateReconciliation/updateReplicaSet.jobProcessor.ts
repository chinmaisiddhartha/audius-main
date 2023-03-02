import type Logger from 'bunyan'
import type { DecoratedJobParams, DecoratedJobReturnValue } from '../types'
import { METRIC_NAMES } from '../../../services/prometheusMonitoring/prometheus.constants'
import {
  getCachedHealthyNodes,
  cacheHealthyNodes
} from './stateReconciliationUtils'
import type {
  IssueSyncRequestJobParams,
  NewReplicaSet,
  ReplicaToUserInfoMap,
  UpdateReplicaSetJobParams,
  UpdateReplicaSetJobReturnValue
} from './types'
import { makeHistogramToRecord } from '../../prometheusMonitoring/prometheusUsageUtils'
import { UpdateReplicaSetJobResult } from '../stateMachineConstants'
import { stringifyMap } from '../../../utils'
import {
  getMapOfCNodeEndpointToSpId,
  getMapOfSpIdToChainInfo
} from '../../ContentNodeInfoManager'
import { instrumentTracing, tracing } from '../../../tracer'

const _ = require('lodash')

const config = require('../../../config')
const {
  SyncType,
  RECONFIG_MODES,
  MAX_SELECT_NEW_REPLICA_SET_ATTEMPTS,
  QUEUE_NAMES,
  SYNC_MODES
} = require('../stateMachineConstants')
const { retrieveClockValueForUserFromReplica } = require('../stateMachineUtils')
const { getNewOrExistingSyncReq } = require('./stateReconciliationUtils')
const initAudiusLibs = require('../../initAudiusLibs')

const reconfigNodeWhitelist = config.get('reconfigNodeWhitelist')
  ? new Set(config.get('reconfigNodeWhitelist').split(','))
  : null

const RECONFIG_SP_IDS_BLACKLIST: number[] = config.get('reconfigSPIdBlacklist')
const RECONFIG_MODE_PRIMARY_ONLY: Boolean = config.get(
  'reconfigModePrimaryOnly'
)

/**
 * Updates replica sets of a user who has one or more unhealthy nodes as their primary or secondaries.
 *
 * @param {Object} param job data
 * @param {Object} param.logger the logger that can be filtered by jobName and jobId
 * @param {number} param.wallet the public key of the user whose replica set will be reconfigured
 * @param {number} param.userId the id of the user whose replica set will be reconfigured
 * @param {number} param.primary the current primary endpoint of the user whose replica set will be reconfigured
 * @param {number} param.secondary1 the current secondary1 endpoint of the user whose replica set will be reconfigured
 * @param {number} param.secondary2 the current secondary2 endpoint of the user whose replica set will be reconfigured
 * @param {string[]} param.nodesToReconfigOffOf the endpoints of the user's replica set that are currently unhealthy and not in a grace period
 * @param {Object} param.replicaToUserInfoMap map(secondary endpoint => { clock, filesHash }) map of user's node endpoint strings to user info on node for user whose replica set should be updated
 * @param {string[]} param.enabledReconfigModes array of which reconfig modes are enabled
 */
const updateReplicaSetJobProcessor = async function ({
  logger,
  wallet,
  userId,
  primary,
  secondary1,
  secondary2,
  nodesToReconfigOffOf,
  replicaToUserInfoMap,
  enabledReconfigModes
}: DecoratedJobParams<UpdateReplicaSetJobParams>): Promise<
  DecoratedJobReturnValue<UpdateReplicaSetJobReturnValue>
> {
  let errorMsg = ''
  let issuedReconfig = false
  let syncJobsToEnqueue: IssueSyncRequestJobParams[] = []
  let newReplicaSet: NewReplicaSet = {
    newPrimary: null,
    newSecondary1: null,
    newSecondary2: null,
    issueReconfig: false,
    reconfigType: null
  }
  let result: UpdateReplicaSetJobResult

  const startTimeMs = Date.now()

  /**
   * Fetch all the healthy nodes while disabling sync checks to select nodes for new replica set
   * Note: sync checks are disabled because there should not be any syncs occurring for a particular user
   * on a new replica set. Also, the sync check logic is coupled with a user state on the userStateManager.
   * There will be an explicit clock value check on the newly selected replica set nodes instead.
   */
  let audiusLibs = null
  let healthyNodes = []
  healthyNodes = await getCachedHealthyNodes()
  if (healthyNodes.length === 0) {
    try {
      tracing.info('init AudiusLibs')
      audiusLibs = await initAudiusLibs({
        enableEthContracts: true,
        enableContracts: true,
        enableDiscovery: true,
        enableIdentity: true,
        logger
      })
    } catch (e: any) {
      tracing.recordException(e)
      result = UpdateReplicaSetJobResult.FailureInitAudiusLibs
      errorMsg = `Error initting libs and auto-selecting creator nodes: ${e.message}: ${e.stack}`
      logger.error(`ERROR ${errorMsg} - ${(e as Error).message}`)

      return {
        errorMsg,
        issuedReconfig,
        newReplicaSet,
        healthyNodes,
        metricsToRecord: [
          makeHistogramToRecord(
            METRIC_NAMES[
              `STATE_MACHINE_${QUEUE_NAMES.UPDATE_REPLICA_SET}_JOB_DURATION_SECONDS_HISTOGRAM`
            ],
            (Date.now() - startTimeMs) / 1000, // Metric is in seconds
            {
              issuedReconfig: issuedReconfig?.toString() || 'false',
              reconfigType: _.snakeCase(newReplicaSet?.reconfigType || 'null'),
              result
            }
          )
        ]
      }
    }

    try {
      const spInfoMap = await getMapOfSpIdToChainInfo(logger)

      const reconfigNodeBlacklist = new Set()
      RECONFIG_SP_IDS_BLACKLIST.forEach((spId) => {
        const info = spInfoMap.get(spId)
        if (info?.endpoint) {
          reconfigNodeBlacklist.add(info.endpoint)
        }
      })

      const { services: healthyServicesMap } =
        await audiusLibs.ServiceProvider.autoSelectCreatorNodes({
          performSyncCheck: false,
          whitelist: reconfigNodeWhitelist,
          blacklist: reconfigNodeBlacklist,
          log: true
        })

      healthyNodes = Object.keys(healthyServicesMap || {})
      if (healthyNodes.length === 0) {
        throw new Error(
          'Auto-selecting Content Nodes returned an empty list of healthy nodes.'
        )
      }
      await cacheHealthyNodes(healthyNodes)
    } catch (e: any) {
      tracing.recordException(e)
      result = UpdateReplicaSetJobResult.FailureFindHealthyNodes
      errorMsg = `Error finding healthy nodes to select - ${e.message}: ${e.stack}`

      return {
        errorMsg,
        issuedReconfig,
        newReplicaSet,
        healthyNodes,
        metricsToRecord: [
          makeHistogramToRecord(
            METRIC_NAMES[
              `STATE_MACHINE_${QUEUE_NAMES.UPDATE_REPLICA_SET}_JOB_DURATION_SECONDS_HISTOGRAM`
            ],
            (Date.now() - startTimeMs) / 1000, // Metric is in seconds
            {
              issuedReconfig: issuedReconfig?.toString() || 'false',
              reconfigType: _.snakeCase(newReplicaSet?.reconfigType || 'null'),
              result
            }
          )
        ]
      }
    }
  }

  try {
    newReplicaSet = await _determineNewReplicaSet({
      logger,
      wallet,
      primary,
      secondary1,
      secondary2,
      nodesToReconfigOffOf: new Set(nodesToReconfigOffOf || []),
      healthyNodes,
      replicaToUserInfoMap,
      enabledReconfigModes
    })

    try {
      ;({ errorMsg, issuedReconfig, syncJobsToEnqueue, result } =
        await _issueUpdateReplicaSetOp(
          userId,
          wallet,
          primary,
          secondary1,
          secondary2,
          newReplicaSet,
          audiusLibs,
          logger
        ))
    } catch (e: any) {
      tracing.recordException(e)
      result = UpdateReplicaSetJobResult.FailureIssueUpdateReplicaSet
      logger.error(
        `ERROR issuing update replica set op: userId=${userId} wallet=${wallet} old replica set=[${primary},${secondary1},${secondary2}] | Error: ${e.toString()}: ${
          e.stack
        }`
      )
      errorMsg = e.toString()
    }
  } catch (e: any) {
    tracing.recordException(e)
    result = UpdateReplicaSetJobResult.FailureDetermineNewReplicaSet
    logger.error(
      `ERROR determining new replica set: userId=${userId} wallet=${wallet} old replica set=[${primary},${secondary1},${secondary2}] | Error: ${e.toString()}: ${
        e.stack
      }`
    )
    errorMsg = e.toString()
  }

  return {
    errorMsg,
    issuedReconfig,
    newReplicaSet,
    healthyNodes,
    metricsToRecord: [
      makeHistogramToRecord(
        METRIC_NAMES[
          `STATE_MACHINE_${QUEUE_NAMES.UPDATE_REPLICA_SET}_JOB_DURATION_SECONDS_HISTOGRAM`
        ],
        (Date.now() - startTimeMs) / 1000, // Metric is in seconds
        {
          result: result || UpdateReplicaSetJobResult.Success,
          issuedReconfig: issuedReconfig?.toString() || 'false',
          reconfigType: _.snakeCase(newReplicaSet?.reconfigType || 'null')
        }
      )
    ],
    jobsToEnqueue: syncJobsToEnqueue?.length
      ? {
          [QUEUE_NAMES.RECURRING_SYNC]: syncJobsToEnqueue
        }
      : undefined
  }
}

type DetermineNewReplicaSetParams = {
  logger: Logger
  primary: string
  secondary1: string
  secondary2: string
  wallet: string
  nodesToReconfigOffOf: Set<string>
  healthyNodes: string[]
  replicaToUserInfoMap: ReplicaToUserInfoMap
  enabledReconfigModes: string[]
}
/**
 * Logic to determine the new replica set.
 *
 * The logic below is as follows:
 * 1. Select the unhealthy replica set nodes size worth of healthy nodes to prepare for issuing reconfig
 * 2. Depending the number and type of unhealthy nodes in `nodesToReconfigOffOf`, issue reconfig depending on if the reconfig mode is enabled:
 *  - if one secondary is unhealthy -> {primary: current primary, secondary1: the healthy secondary, secondary2: new healthy node}
 *  - if two secondaries are unhealthy -> {primary: current primary, secondary1: new healthy node, secondary2: new healthy node}
 *  - ** if one primary is unhealthy -> {primary: higher clock value of the two secondaries, secondary1: the healthy secondary, secondary2: new healthy node}
 *  - ** if one primary and one secondary are unhealthy -> {primary: the healthy secondary, secondary1: new healthy node, secondary2: new healthy node}
 *  - if entire replica set is unhealthy -> {primary: null, secondary1: null, secondary2: null, issueReconfig: false}
 *
 * ** - If in the case a primary is ever unhealthy, we do not want to pre-emptively issue a reconfig and cycle out the primary. See `../CNodeHealthManager.ts` for more information.
 *
 * Also, there is the notion of `issueReconfig` flag. This value is used to determine whether or not to issue a reconfig based on the currently enabled reconfig mode. See `RECONFIG_MODE` variable for more information.
 *
 * @param {Object} param
 * @param {Object} param.logger the logger that can be filtered by jobName and jobId
 * @param {string} param.primary current user's primary endpoint
 * @param {string} param.secondary1 current user's first secondary endpoint
 * @param {string} param.secondary2 current user's second secondary endpoint
 * @param {string} param.wallet current user's wallet address
 * @param {Set<string>} param.nodesToReconfigOffOf a set of endpoints of unhealthy replica set nodes that are not in a grace period
 * @param {string[]} param.healthyNodes array of healthy Content Node endpoints used for selecting new replica set
 * @param {Object} param.replicaSetNodesToUserClockStatusesMap map of secondary endpoint strings to clock value of secondary for user whose replica set should be updated
 * @param {Object} param.replicaToUserInfoMap map(secondary endpoint => { clock, filesHash }) map of user's node endpoint strings to user info on node for user whose replica set should be updated
 * @param {string[]} param.enabledReconfigModes array of which reconfig modes are enabled
 * @returns {Object}
 * {
 *  newPrimary: {string | null} the endpoint of the newly selected primary or null,
 *  newSecondary1: {string | null} the endpoint of the newly selected secondary #1,
 *  newSecondary2: {string | null} the endpoint of the newly selected secondary #2,
 *  issueReconfig: {boolean} flag to issue reconfig or not
 * }
 */
const _determineNewReplicaSet = async ({
  logger,
  primary,
  secondary1,
  secondary2,
  wallet,
  nodesToReconfigOffOf,
  healthyNodes,
  replicaToUserInfoMap,
  enabledReconfigModes
}: DetermineNewReplicaSetParams) => {
  const currentReplicaSet = [primary, secondary1, secondary2]
  const healthyReplicaSet = new Set(
    currentReplicaSet
      // Ensure exists
      .filter((_node) => Boolean)
      // Node is not marked unhealthy
      .filter((node) => !nodesToReconfigOffOf.has(node))
  )
  const numberOfEmptyReplicas = currentReplicaSet.filter((node) => !node).length
  const newReplicaNodes = await _selectRandomReplicaSetNodes(
    healthyReplicaSet,
    nodesToReconfigOffOf,
    numberOfEmptyReplicas,
    healthyNodes,
    wallet,
    logger
  )

  if (nodesToReconfigOffOf.size + numberOfEmptyReplicas === 1) {
    return _determineNewReplicaSetWhenOneNodeIsUnhealthy(
      primary,
      secondary1,
      secondary2,
      nodesToReconfigOffOf,
      replicaToUserInfoMap,
      newReplicaNodes[0],
      enabledReconfigModes
    )
  } else if (nodesToReconfigOffOf.size + numberOfEmptyReplicas === 2) {
    return _determineNewReplicaSetWhenTwoNodesAreUnhealthy(
      primary,
      secondary1,
      secondary2,
      nodesToReconfigOffOf,
      newReplicaNodes,
      enabledReconfigModes
    )
  }

  // Can't replace all 3 replicas because there would be no replica to sync from
  return {
    newPrimary: null,
    newSecondary1: null,
    newSecondary2: null,
    issueReconfig: false,
    reconfigType: null
  }
}

/**
 * Determines new replica set when one node in the current replica set is unhealthy.
 * @param {*} primary user's current primary endpoint
 * @param {*} secondary1 user's current first secondary endpoint
 * @param {*} secondary2 user's current second secondary endpoint
 * @param {*} nodesToReconfigOffOf a set of endpoints of unhealthy replica set nodes that are not in a grace period
 * @param {Object} param.replicaToUserInfoMap map(secondary endpoint => { clock, filesHash }) map of user's node endpoint strings to user info on node for user whose replica set should be updated
 * @param {*} newReplicaNode endpoint of node that will replace the unhealthy node
 * @returns reconfig info to update the user's replica set to replace the 1 unhealthy node
 */
const _determineNewReplicaSetWhenOneNodeIsUnhealthy = (
  primary: string,
  secondary1: string,
  secondary2: string,
  nodesToReconfigOffOf: Set<string>,
  replicaToUserInfoMap: ReplicaToUserInfoMap,
  newReplicaNode: string,
  enabledReconfigModes: string[]
) => {
  // If we already already checked this primary and it failed the health check, select the higher clock
  // value of the two secondaries as the new primary, leave the other as the first secondary, and select a new second secondary
  if (nodesToReconfigOffOf.has(primary) || !primary) {
    const secondary1Clock = replicaToUserInfoMap[secondary1]?.clock || -1
    const secondary2Clock = replicaToUserInfoMap[secondary2]?.clock || -1
    const [newPrimary, currentHealthySecondary] =
      secondary1Clock >= secondary2Clock
        ? [secondary1, secondary2]
        : [secondary2, secondary1]
    return {
      newPrimary,
      newSecondary1: currentHealthySecondary,
      newSecondary2: newReplicaNode,
      issueReconfig: _isReconfigEnabled(
        enabledReconfigModes,
        RECONFIG_MODES.PRIMARY_AND_OR_SECONDARIES.key
      ),
      reconfigType: RECONFIG_MODES.PRIMARY_AND_OR_SECONDARIES.key
    }
  }

  // If one secondary is unhealthy, select a new secondary
  const currentHealthySecondary =
    nodesToReconfigOffOf.has(secondary1) || !secondary1
      ? secondary2
      : secondary1
  return {
    newPrimary: primary,
    newSecondary1: currentHealthySecondary,
    newSecondary2: newReplicaNode,
    issueReconfig: _isReconfigEnabled(
      enabledReconfigModes,
      RECONFIG_MODES.ONE_SECONDARY.key
    ),
    reconfigType: RECONFIG_MODES.ONE_SECONDARY.key
  }
}

/**
 * Determines new replica set when two nodes in the current replica set are unhealthy.
 * @param {*} primary user's current primary endpoint
 * @param {*} secondary1 user's current first secondary endpoint
 * @param {*} secondary2 user's current second secondary endpoint
 * @param {*} nodesToReconfigOffOf a set of endpoints of unhealthy replica set nodes that are not in a grace period
 * @param {*} newReplicaNodes array of endpoints of nodes that will replace the unhealthy nodes
 * @returns reconfig info to update the user's replica set to replace the 1 unhealthy nodes
 */
const _determineNewReplicaSetWhenTwoNodesAreUnhealthy = (
  primary: string,
  secondary1: string,
  secondary2: string,
  nodesToReconfigOffOf: Set<string>,
  newReplicaNodes: string[],
  enabledReconfigModes: string[]
) => {
  // If primary + secondary is unhealthy, use other healthy secondary as primary and 2 random secondaries
  if (nodesToReconfigOffOf.has(primary) || !primary) {
    return {
      newPrimary: !nodesToReconfigOffOf.has(secondary1)
        ? secondary1
        : secondary2,
      newSecondary1: newReplicaNodes[0],
      newSecondary2: newReplicaNodes[1],
      issueReconfig: _isReconfigEnabled(
        enabledReconfigModes,
        RECONFIG_MODES.PRIMARY_AND_OR_SECONDARIES.key
      ),
      reconfigType: RECONFIG_MODES.PRIMARY_AND_OR_SECONDARIES.key
    }
  }

  // If both secondaries are unhealthy, keep original primary and select two random secondaries
  return {
    newPrimary: primary,
    newSecondary1: newReplicaNodes[0],
    newSecondary2: newReplicaNodes[1],
    issueReconfig: _isReconfigEnabled(
      enabledReconfigModes,
      RECONFIG_MODES.MULTIPLE_SECONDARIES.key
    ),
    reconfigType: RECONFIG_MODES.MULTIPLE_SECONDARIES.key
  }
}

/**
 * Select a random healthy node that is not from the current replica set and not in the unhealthy replica set.
 *
 * If an insufficient amount of new replica set nodes are chosen, this method will throw an error.
 * @param {Set<string>} healthyReplicaSet a set of the healthy replica set endpoints
 * @param {Set<string>} nodesToReconfigOffOf a set of the unhealthy replica set endpoints that are not in a grace period
 * @param {number} numberOfEmptyReplicas the number of the user's replicas that are an empty string (deregistered SP ID)
 * @param {string[]} healthyNodes an array of all the healthy nodes available on the network
 * @param {string} wallet the wallet of the current user
 * @param {Object} logger a logger that can be filtered on jobName and jobId
 * @returns {string[]} a string[] of the new replica set nodes
 */
const _selectRandomReplicaSetNodes = async (
  healthyReplicaSet: Set<string>,
  nodesToReconfigOffOf: Set<string>,
  numberOfEmptyReplicas: number,
  healthyNodes: string[],
  wallet: string,
  logger: Logger
): Promise<string[]> => {
  const numberOfNodesToReconfigOffOf = nodesToReconfigOffOf.size
  const logStr = `[_selectRandomReplicaSetNodes] wallet=${wallet} healthyReplicaSet=[${[
    ...healthyReplicaSet
  ]}] numberOfNodesToReconfigOffOf=${numberOfNodesToReconfigOffOf} numberOfEmptyReplicas=${numberOfEmptyReplicas} healthyNodes=${[
    ...healthyNodes
  ]} ||`

  const newReplicaNodesSet = new Set<string>()

  const viablePotentialReplicas = healthyNodes.filter(
    (node) => !healthyReplicaSet.has(node)
  )

  let selectNewReplicaSetAttemptCounter = 0
  while (
    newReplicaNodesSet.size <
      numberOfNodesToReconfigOffOf + numberOfEmptyReplicas &&
    selectNewReplicaSetAttemptCounter++ < MAX_SELECT_NEW_REPLICA_SET_ATTEMPTS
  ) {
    const randomHealthyNode = _.sample(viablePotentialReplicas)

    // If node is already present in new replica set or is part of the existing replica set, keep finding a unique healthy node
    if (newReplicaNodesSet.has(randomHealthyNode)) continue

    // If the node was marked as healthy before, keep finding a unique healthy node
    if (nodesToReconfigOffOf.has(randomHealthyNode)) {
      logger.warn(
        `Selected node ${randomHealthyNode} that is marked as healthy now but was previously marked as unhealthy. Unselecting it and finding another healthy node...`
      )
      continue
    }

    // Check to make sure that the newly selected secondary does not have existing user state
    try {
      const clockValue = await retrieveClockValueForUserFromReplica(
        randomHealthyNode,
        wallet
      )
      newReplicaNodesSet.add(randomHealthyNode)
      if (clockValue !== -1) {
        logger.warn(
          `${logStr} Found a node with previous state (clock value of ${clockValue}), selecting anyway`
        )
      }
    } catch (e: any) {
      // Something went wrong in checking clock value. Reselect another secondary.
      logger.error(
        `${logStr} randomHealthyNode=${randomHealthyNode} ${e.message}`
      )
    }
  }

  if (
    newReplicaNodesSet.size <
    numberOfNodesToReconfigOffOf + numberOfEmptyReplicas
  ) {
    throw new Error(
      `${logStr} Not enough healthy nodes found to issue new replica set after ${MAX_SELECT_NEW_REPLICA_SET_ATTEMPTS} attempts`
    )
  }

  return Array.from(newReplicaNodesSet)
}

type IssueUpdateReplicaSetResult = {
  result: UpdateReplicaSetJobResult
  errorMsg: string
  issuedReconfig: boolean
  syncJobsToEnqueue: IssueSyncRequestJobParams[]
}
/**
 * 1. Write new replica set to URSM
 * 2. Return sync jobs that can be enqueued to write data to new replica set
 *
 * @param {number} userId user id to issue a reconfiguration for
 * @param {string} wallet wallet address of user id
 * @param {string} primary endpoint of the current primary node on replica set
 * @param {string} secondary1 endpoint of the current first secondary node on replica set
 * @param {string} secondary2 endpoint of the current second secondary node on replica set
 * @param {Object} newReplicaSet {newPrimary, newSecondary1, newSecondary2, issueReconfig, reconfigType}
 * @param {Object} logger a logger that can be filtered on jobName and jobId
 */
const _issueUpdateReplicaSetOp = async (
  userId: number,
  wallet: string,
  primary: string,
  secondary1: string,
  secondary2: string,
  newReplicaSet: NewReplicaSet,
  audiusLibs: any,
  logger: Logger
): Promise<IssueUpdateReplicaSetResult> => {
  const response: IssueUpdateReplicaSetResult = {
    result: UpdateReplicaSetJobResult.Success,
    errorMsg: '',
    issuedReconfig: false,
    syncJobsToEnqueue: []
  }
  let newReplicaSetEndpoints: string[] = []
  const newReplicaSetSPIds = []
  try {
    const {
      newPrimary,
      newSecondary1,
      newSecondary2,
      issueReconfig,
      reconfigType
    } = newReplicaSet
    newReplicaSetEndpoints = [
      newPrimary || '',
      newSecondary1 || '',
      newSecondary2 || ''
    ].filter(Boolean)

    logger.info(
      `[_issueUpdateReplicaSetOp] userId=${userId} wallet=${wallet} newReplicaSetEndpoints=${JSON.stringify(
        newReplicaSetEndpoints
      )}`
    )

    if (newReplicaSetEndpoints.length !== 3) {
      const errorMsg = `Tried to reconfig to an incomplete replica set: ${JSON.stringify(
        newReplicaSetEndpoints
      )}`
      logger.error(errorMsg)
      throw new Error(errorMsg)
    }

    if (!issueReconfig) {
      response.result = UpdateReplicaSetJobResult.SuccessIssueReconfigDisabled
      return response
    }

    const cNodeEndpointToSpIdMap = await getMapOfCNodeEndpointToSpId(logger)

    // Create new array of replica set spIds and write to contract
    for (const endpt of newReplicaSetEndpoints) {
      // If for some reason any node in the new replica set is not registered on chain as a valid SP and is
      // selected as part of the new replica set, do not issue reconfig
      const spIdFromChain = cNodeEndpointToSpIdMap.get(endpt)
      if (spIdFromChain === undefined) {
        response.result = UpdateReplicaSetJobResult.FailureNoValidSP
        response.errorMsg = `[_issueUpdateReplicaSetOp] userId=${userId} wallet=${wallet} unable to find valid SPs from new replica set=[${newReplicaSetEndpoints}] | new replica set spIds=[${newReplicaSetSPIds}] | reconfig type=[${reconfigType}] | endpointToSPIdMap=${stringifyMap(
          cNodeEndpointToSpIdMap
        )} | endpt=${endpt}. Skipping reconfig.`
        logger.error(response.errorMsg)
        return response
      }
      newReplicaSetSPIds.push(spIdFromChain)
    }

    // Submit chain tx to update replica set
    const startTimeMs = Date.now()
    try {
      if (!audiusLibs) {
        tracing.info('init AudiusLibs')
        audiusLibs = await initAudiusLibs({
          enableEthContracts: true,
          enableContracts: true,
          enableDiscovery: true,
          enableIdentity: true,
          logger
        })
      }
    } catch (e: any) {
      throw new Error(
        `[_issueUpdateReplicaSetOp] Could not initialize libs ${
          Date.now() - startTimeMs
        }ms - Error ${e.message}`
      )
    }

    try {
      const oldPrimarySpId = cNodeEndpointToSpIdMap.get(primary)
      const oldSecondary1SpId = cNodeEndpointToSpIdMap.get(secondary1)
      const oldSecondary2SpId = cNodeEndpointToSpIdMap.get(secondary2)

      const { canReconfig, chainPrimarySpId, chainSecondarySpIds, error } =
        await _canReconfig({
          libs: audiusLibs,
          oldPrimarySpId,
          oldSecondary1SpId,
          oldSecondary2SpId,
          userId,
          logger
        })

      if (error) {
        response.result = error
      }

      if (!canReconfig) {
        response.result = UpdateReplicaSetJobResult.SkipUpdateReplicaSet
        logger.info(
          `[_issueUpdateReplicaSetOp] skipping _updateReplicaSet as reconfig already occurred for userId=${userId} wallet=${wallet}`
        )
        return response
      }

      if (!config.get('entityManagerReplicaSetEnabled')) {
        throw new Error(
          `[_issueUpdateReplicaSetOp] entityManagerReplicaSet not enabled`
        )
      }

      logger.info(
        `[_issueUpdateReplicaSetOp] updating replica set now ${
          Date.now() - startTimeMs
        }ms for userId=${userId} wallet=${wallet}`
      )

      const { blockNumber } =
        await audiusLibs.User.updateEntityManagerReplicaSet({
          userId,
          primary: newReplicaSetSPIds[0], // new primary
          secondaries: newReplicaSetSPIds.slice(1), // [new secondary1, new secondary2]
          // This defaulting logic is for the edge case when an SP deregistered and can't be fetched from our mapping, so we use the SP ID from the user's old replica set queried from the chain
          oldPrimary: oldPrimarySpId || chainPrimarySpId,
          oldSecondaries: [
            oldSecondary1SpId || chainSecondarySpIds?.[0],
            oldSecondary2SpId || chainSecondarySpIds?.[1]
          ]
        })
      logger.info(
        `[_issueUpdateReplicaSetOp] did call audiusLibs.User.updateEntityManagerReplicaSet waiting for ${blockNumber}`
      )
      // Wait for blockhash/blockNumber to be indexed
      try {
        await audiusLibs.User.waitForReplicaSetDiscoveryIndexing(
          userId,
          newReplicaSetSPIds,
          blockNumber
        )
      } catch (err: any) {
        throw new Error(
          `[_issueUpdateReplicaSetOp] waitForReplicaSetDiscovery Indexing Unable to confirm updated replica set for user ${userId}. Error: ${err.message}`
        )
      }

      response.issuedReconfig = true
      logger.info(
        `[_issueUpdateReplicaSetOp] _updateReplicaSet took ${
          Date.now() - startTimeMs
        }ms for userId=${userId} wallet=${wallet}`
      )
    } catch (e: any) {
      throw new Error(
        `[_issueUpdateReplicaSetOp] _updateReplicaSet Failed in ${
          Date.now() - startTimeMs
        }ms - Error ${e.message}`
      )
    }

    // Enqueue a sync from new primary to new secondary1. If there is no diff, then this is a no-op.
    const { duplicateSyncReq, syncReqToEnqueue: syncToEnqueueToSecondary1 } =
      await getNewOrExistingSyncReq({
        userWallet: wallet,
        primaryEndpoint: newPrimary,
        secondaryEndpoint: newSecondary1,
        syncType: SyncType.Recurring,
        syncMode: SYNC_MODES.SyncSecondaryFromPrimary
      })
    if (!_.isEmpty(duplicateSyncReq)) {
      logger.warn(
        `[_issueUpdateReplicaSetOp] Reconfig had duplicate sync request to secondary1: ${duplicateSyncReq}`
      )
    } else if (!_.isEmpty(syncToEnqueueToSecondary1)) {
      response.syncJobsToEnqueue.push(syncToEnqueueToSecondary1)
    }

    // Enqueue a sync from new primary to new secondary2. If there is no diff, then this is a no-op.
    const {
      duplicateSyncReq: duplicateSyncReq2,
      syncReqToEnqueue: syncToEnqueueToSecondary2
    } = getNewOrExistingSyncReq({
      userWallet: wallet,
      primaryEndpoint: newPrimary,
      secondaryEndpoint: newSecondary2,
      syncType: SyncType.Recurring,
      syncMode: SYNC_MODES.SyncSecondaryFromPrimary
    })
    if (!_.isEmpty(duplicateSyncReq2)) {
      logger.warn(
        `[_issueUpdateReplicaSetOp] Reconfig had duplicate sync request to secondary2: ${duplicateSyncReq2}`
      )
    } else if (!_.isEmpty(syncToEnqueueToSecondary2)) {
      response.syncJobsToEnqueue.push(syncToEnqueueToSecondary2)
    }

    logger.info(
      `[_issueUpdateReplicaSetOp] Reconfig SUCCESS: userId=${userId} wallet=${wallet} old replica set=[${primary},${secondary1},${secondary2}] | new replica set=[${newReplicaSetEndpoints}] | reconfig type=[${reconfigType}]`
    )
  } catch (e: any) {
    response.result = UpdateReplicaSetJobResult.FailureToUpdateReplicaSet

    response.errorMsg = `[_issueUpdateReplicaSetOp] Reconfig ERROR: userId=${userId} wallet=${wallet} old replica set=[${primary},${secondary1},${secondary2}] | new replica set=[${newReplicaSetEndpoints}] | Error: ${e.toString()}`
    logger.error(`${response.errorMsg}: ${e.stack}`)
  }

  return response
}

/**
 * Given the current mode, determine if reconfig is enabled
 * @param
 * @param {string} mode current mode of the state machine
 * @returns boolean of whether or not reconfig is enabled
 */
const _isReconfigEnabled = (enabledReconfigModes: string[], mode: string) => {
  if (mode === RECONFIG_MODES.RECONFIG_DISABLED.key) return false

  // If primary only override is enabled, only issue reconfig if mode is in enabled modes set and indicates a primary reconfig
  if (RECONFIG_MODE_PRIMARY_ONLY) {
    return (
      enabledReconfigModes.includes(mode) &&
      mode === RECONFIG_MODES.PRIMARY_AND_OR_SECONDARIES.key
    )
  }

  return enabledReconfigModes.includes(mode)
}

type CanReconfigParams = {
  libs: any
  oldPrimarySpId: number | undefined
  oldSecondary1SpId: number | undefined
  oldSecondary2SpId: number | undefined
  userId: number
  logger: Logger
}

type CanReconfigReturnValue = {
  canReconfig: boolean
  error?: UpdateReplicaSetJobResult
  chainPrimarySpId?: number
  chainSecondarySpIds?: number[]
}

const _canReconfig = async ({
  libs,
  oldPrimarySpId,
  oldSecondary1SpId,
  oldSecondary2SpId,
  userId,
  logger
}: CanReconfigParams): Promise<CanReconfigReturnValue> => {
  let error
  try {
    let chainPrimarySpId, chainSecondarySpIds
    if (config.get('entityManagerReplicaSetEnabled')) {
      const encodedUserId = libs.Utils.encodeHashId(userId)
      const spResponse = await libs.discoveryProvider.getUserReplicaSet({
        encodedUserId
      })
      chainPrimarySpId = spResponse?.primarySpID
      chainSecondarySpIds = [
        spResponse?.secondary1SpID,
        spResponse?.secondary2SpID
      ]
    } else {
      const response =
        await libs.contracts.UserReplicaSetManagerClient.getUserReplicaSet(
          userId
        )
      chainPrimarySpId = response.primaryId
      chainSecondarySpIds = response.secondaryIds
    }

    if (
      !chainPrimarySpId ||
      !chainSecondarySpIds ||
      chainSecondarySpIds.length < 2
    ) {
      error = UpdateReplicaSetJobResult.FailureGetCurrentReplicaSet
      throw new Error(
        `Could not get current replica set: chainPrimarySpId=${chainPrimarySpId} chainSecondarySpIds=${JSON.stringify(
          chainSecondarySpIds || []
        )}`
      )
    }

    // Reconfig is necessary if endpoint doesn't exist in mapping because this means the node was deregistered
    const isAnyNodeInReplicaSetDeregistered =
      !oldPrimarySpId || !oldSecondary1SpId || !oldSecondary2SpId
    if (isAnyNodeInReplicaSetDeregistered) {
      return {
        error,
        canReconfig: true,
        chainPrimarySpId,
        chainSecondarySpIds
      }
    }

    // Reconfig should only happen when the replica set that triggered the reconfig matches the chain
    const isReplicaSetCurrent =
      chainPrimarySpId === oldPrimarySpId &&
      chainSecondarySpIds[0] === oldSecondary1SpId &&
      chainSecondarySpIds[1] === oldSecondary2SpId
    return {
      error,
      canReconfig: isReplicaSetCurrent
    }
  } catch (e: any) {
    logger.error(
      `[_issueUpdateReplicaSetOp] error in _canReconfig. : ${e.message}`
    )
  }

  // If any error occurs in determining if a reconfig event can happen, default to issuing
  // a reconfig event anyway just to prevent users from keeping an unhealthy replica set
  return {
    error,
    canReconfig: true
  }
}

module.exports = async (
  params: DecoratedJobParams<UpdateReplicaSetJobParams>
) => {
  const { parentSpanContext } = params
  const jobProcessor = instrumentTracing({
    name: 'updateReplicaSet.jobProcessor',
    fn: updateReplicaSetJobProcessor,
    options: {
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

  return await jobProcessor(params)
}
