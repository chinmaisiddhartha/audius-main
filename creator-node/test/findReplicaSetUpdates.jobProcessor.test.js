/* eslint-disable no-unused-expressions */
const chai = require('chai')
const sinon = require('sinon')
const { expect } = chai
const proxyquire = require('proxyquire')

const { getApp } = require('./lib/app')
const { getLibsMock } = require('./lib/libsMock')

const config = require('../src/config')
const {
  QUEUE_NAMES
} = require('../src/services/stateMachineManager/stateMachineConstants')

chai.use(require('sinon-chai'))
chai.use(require('chai-as-promised'))

describe('test findReplicaSetUpdates job processor', function () {
  let server, sandbox, originalContentNodeEndpoint, logger

  beforeEach(async function () {
    const appInfo = await getApp(getLibsMock())
    await appInfo.app.get('redisClient').flushdb()
    server = appInfo.server
    sandbox = sinon.createSandbox()
    config.set('spID', 1)
    originalContentNodeEndpoint = config.get('creatorNodeEndpoint')
    logger = {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub()
    }
  })

  afterEach(async function () {
    await server.close()
    sandbox.restore()
    config.set('creatorNodeEndpoint', originalContentNodeEndpoint)
    logger = null
  })

  const primary = 'http://primary_cn.co'
  const secondary1 = 'http://secondary1.co'
  const secondary2 = 'http://secondary2.co'
  const primarySpID = 1
  const secondary1SpID = 2
  const secondary2SpID = 3
  const user_id = 1
  const wallet = '0x123456789'
  const users = [
    {
      primary,
      secondary1,
      secondary2,
      primarySpID,
      secondary1SpID,
      secondary2SpID,
      user_id,
      wallet
    }
  ]

  const DEFAULT_CNODE_ENDOINT_TO_SP_ID_MAP = new Map(
    Object.entries({
      [primary]: primarySpID,
      [secondary1]: secondary1SpID,
      [secondary2]: secondary2SpID
    })
  )

  const CNODE_ENDOINT_TO_SP_ID_MAP_WHERE_SECONDARY1_MISMATCHES = new Map(
    Object.entries({
      [primary]: primarySpID,
      [secondary1]: secondary1SpID + 100,
      [secondary2]: secondary2SpID
    })
  )

  const DEFAULT_REPLICA_TO_USER_INFO_MAP = {
    [primary]: {
      [wallet]: { clock: 10, filesHash: '0xasdf' },
      randomWallet: { clock: 10, filesHash: '0xasdf' }
    },
    [secondary1]: {
      [wallet]: { clock: 10, filesHash: '0xasdf' },
      anotherWallet: { clock: 100, filesHash: '0xnotasdf' }
    },
    [secondary2]: {
      [wallet]: { clock: 10, filesHash: '0xasdf' }
    },
    unusedNode: {}
  }

  const REPLICA_TO_USER_INFO_MAP_FILTERED_TO_WALLET = {
    [primary]: { clock: 10, filesHash: '0xasdf' },
    [secondary1]: { clock: 10, filesHash: '0xasdf' },
    [secondary2]: { clock: 10, filesHash: '0xasdf' }
  }

  function getJobProcessorStub(
    isNodeHealthyOrInGracePeriodStub,
    getCNodeEndpointToSpIdMapStub
  ) {
    return proxyquire(
      '../src/services/stateMachineManager/stateMonitoring/findReplicaSetUpdates.jobProcessor.ts',
      {
        '../../../config': config,
        '../CNodeHealthManager': {
          CNodeHealthManager: {
            isNodeHealthyOrInGracePeriod: isNodeHealthyOrInGracePeriodStub
          }
        },
        '../../ContentNodeInfoManager': {
          getMapOfCNodeEndpointToSpId: getCNodeEndpointToSpIdMapStub
        }
      }
    )
  }

  async function runJobProcessor({
    cNodeEndpointToSpIdMap = DEFAULT_CNODE_ENDOINT_TO_SP_ID_MAP,
    secondarySyncHealthTrackerState = {
      walletToSecondaryAndMaxErrorReached: {}
    },
    unhealthyPeers = [],
    isPrimaryHealthyInExtraHealthCheck = false
  }) {
    const getCNodeEndpointToSpIdMapStub = sandbox
      .stub()
      .resolves(cNodeEndpointToSpIdMap)
    const isNodeHealthyOrInGracePeriodStub = sandbox
      .stub()
      .resolves(isPrimaryHealthyInExtraHealthCheck)

    const findReplicaSetUpdatesJobProcessor = getJobProcessorStub(
      isNodeHealthyOrInGracePeriodStub,
      getCNodeEndpointToSpIdMapStub
    )

    // Verify job outputs the correct results: primary should be removed from replica set because it's unhealthy
    return findReplicaSetUpdatesJobProcessor({
      logger,
      users,
      unhealthyPeers,
      replicaToAllUserInfoMaps: DEFAULT_REPLICA_TO_USER_INFO_MAP,
      secondarySyncHealthTrackerState
    })
  }

  async function runAndVerifyJobProcessor({
    expectedUnhealthyReplicas = [],
    jobProcessorArgs = {}
  }) {
    const jobOutput = await runJobProcessor(jobProcessorArgs)

    expect(jobOutput.cNodeEndpointToSpIdMap).to.deep.equal(
      JSON.stringify(
        Array.from(
          (
            jobProcessorArgs?.cNodeEndpointToSpIdMap ||
            DEFAULT_CNODE_ENDOINT_TO_SP_ID_MAP
          ).entries()
        )
      )
    )

    if (expectedUnhealthyReplicas?.length) {
      expect(
        jobOutput.jobsToEnqueue[QUEUE_NAMES.UPDATE_REPLICA_SET].length
      ).to.equal(1)

      const { parentSpanContext, ...rest } =
        jobOutput.jobsToEnqueue[QUEUE_NAMES.UPDATE_REPLICA_SET][0]
      expect(rest).to.deep.equal({
        wallet,
        userId: user_id,
        primary,
        secondary1,
        secondary2,
        nodesToReconfigOffOf: expectedUnhealthyReplicas,
        replicaToUserInfoMap: REPLICA_TO_USER_INFO_MAP_FILTERED_TO_WALLET
      })
    } else {
      expect(jobOutput.jobsToEnqueue).to.not.exist
    }
  }

  it('issues update for mismatched spIds when this node is primary', async function () {
    // Make this node be the user's primary
    config.set('creatorNodeEndpoint', primary)

    // Verify job outputs the correct results: secondary1 should be removed from replica set because its spId mismatches
    return runAndVerifyJobProcessor({
      jobProcessorArgs: {
        cNodeEndpointToSpIdMap:
          CNODE_ENDOINT_TO_SP_ID_MAP_WHERE_SECONDARY1_MISMATCHES
      },
      expectedUnhealthyReplicas: [secondary1]
    })
  })

  it('issues update for mismatched spIds when this node is secondary', async function () {
    // Make this node be the user's secondary
    config.set('creatorNodeEndpoint', secondary2)

    // Verify job outputs the correct results: secondary1 should be removed from replica set because its spId mismatches
    return runAndVerifyJobProcessor({
      jobProcessorArgs: {
        cNodeEndpointToSpIdMap:
          CNODE_ENDOINT_TO_SP_ID_MAP_WHERE_SECONDARY1_MISMATCHES
      },
      expectedUnhealthyReplicas: [secondary1]
    })
  })

  it('issues update for unhealthy primary when this node is secondary and primary fails extra health check', async function () {
    // Make this node be the user's secondary
    config.set('creatorNodeEndpoint', secondary1)

    // Verify job outputs the correct results: primary should be removed from replica set because it's unhealthy
    return runAndVerifyJobProcessor({
      jobProcessorArgs: {
        // Mark a primary as unhealthy to trigger a replica set update (if its extra health check also fails)
        unhealthyPeers: [primary],
        // Make the primary fail the extra health check so it gets removed from the user's replica set
        isPrimaryHealthyInExtraHealthCheck: false
      },
      expectedUnhealthyReplicas: [primary]
    })
  })

  it('does not issue update for unhealthy primary when this node is secondary and primary passes extra health check', async function () {
    // Make this node be the user's secondary
    config.set('creatorNodeEndpoint', secondary1)

    // Verify job outputs the correct results: primary should NOT be removed from replica set because it's unhealthy but passed the extra health check
    return runAndVerifyJobProcessor({
      jobProcessorArgs: {
        // Mark a primary as unhealthy to trigger a replica set update (if its extra health check also fails)
        unhealthyPeers: [primary],
        // Make the primary pass the extra health check so it doesn't get removed from the user's replica set
        isPrimaryHealthyInExtraHealthCheck: true
      },
      expectedUnhealthyReplicas: null
    })
  })

  it('issues update for node marked unhealthy when this node is primary', async function () {
    // Make this node be the user's primary
    config.set('creatorNodeEndpoint', primary)

    // Verify job outputs the correct results: secondary2 should be removed from replica set because it's unhealthy
    return runAndVerifyJobProcessor({
      jobProcessorArgs: {
        // Mark a secondary2 as unhealthy to trigger a replica set update
        unhealthyPeers: [secondary2]
      },
      expectedUnhealthyReplicas: [secondary2]
    })
  })

  it('issues update for node marked unhealthy when this node is secondary', async function () {
    // Make this node be the user's secondary
    config.set('creatorNodeEndpoint', secondary1)

    // Verify job outputs the correct results: secondary2 should be removed from replica set because it's unhealthy
    return runAndVerifyJobProcessor({
      jobProcessorArgs: {
        // Mark a secondary2 as unhealthy to trigger a replica set update
        unhealthyPeers: [secondary2]
      },
      expectedUnhealthyReplicas: [secondary2]
    })
  })

  it('issues update for low sync success when this node is primary', async function () {
    // Force max errors encountered for the wallet
    const secondarySyncHealthTrackerState = {
      walletToSecondaryAndMaxErrorReached: {
        [wallet]: {
          [secondary1]: 'failure_undefined_sync_status'
        }
      }
    }

    // Make this node be the user's primary
    config.set('creatorNodeEndpoint', primary)

    // Verify job outputs the correct results: secondary1 should be removed from replica set because its sync success rate is too low
    return runAndVerifyJobProcessor({
      jobProcessorArgs: {
        secondarySyncHealthTrackerState
      },
      expectedUnhealthyReplicas: [secondary1]
    })
  })
})
