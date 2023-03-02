#!/usr/bin/env sh

### Environment Variables

# Unique to each node

export delegateOwnerWallet=$(printenv "CN${replica}_SP_OWNER_ADDRESS")
export delegatePrivateKey=$(printenv "CN${replica}_SP_OWNER_PRIVATE_KEY")

export spOwnerWallet=$(printenv "CN${replica}_SP_OWNER_ADDRESS")
export spID=$replica

export creatorNodeEndpoint="http://audius-protocol-creator-node-${replica}:4000"

# Constants

export logLevel="debug"
export devMode="true"
export creatorNodeIsDebug="true"
export debuggerPort=10000
export expressAppConcurrency=2

export identityService="http://identity-service:7000"

export rateLimitingAudiusUserReqLimit=3000
export rateLimitingUserReqLimit=3000
export rateLimitingMetadataReqLimit=3000
export rateLimitingImageReqLimit=6000
export rateLimitingTrackReqLimit=6000
export rateLimitingBatchCidsExistLimit=1
export maxAudioFileSizeBytes=250000000
export maxMemoryFileSizeBytes=50000000

export ethProviderUrl="http://eth-ganache:8545"
export ethTokenAddress="${ETH_TOKEN_ADDRESS}"
export ethRegistryAddress="${ETH_REGISTRY_ADDRESS}"
export ethOwnerWallet="${ETH_OWNER_WALLET}"
export dataProviderUrl="http://poa-ganache:8545"
export dataRegistryAddress="${POA_REGISTRY_ADDRESS}"

export storagePath=/file_storage
export port=4000
export redisPort=6379

# Sync / SnapbackSM configs
export stateMonitoringQueueRateLimitInterval=60000
export stateMonitoringQueueRateLimitJobsPerInterval=1
export snapbackModuloBase=3
export minimumDailySyncCount=5
export minimumRollingSyncCount=10
export minimumSuccessfulSyncCountPercentage=50
export snapbackHighestReconfigMode=PRIMARY_AND_OR_SECONDARIES
export secondaryUserSyncDailyFailureCountThreshold=100
export maxSyncMonitoringDurationInMs=10000 # 10sec
export skippedCIDsRetryQueueJobIntervalMs=30000 # 30sec in ms
export monitorStateJobLastSuccessfulRunDelayMs=600000 # 10min in ms
export findSyncRequestsJobLastSuccessfulRunDelayMs=600000 # 10min in ms
export findReplicaSetUpdatesJobLastSuccessfulRunDelayMs=600000 # 10min in ms
export fetchCNodeEndpointToSpIdMapIntervalMs=10000 #10sec in ms
export enforceWriteQuorum=true
export recoverOrphanedDataQueueRateLimitInterval=60000 #1min in ms
export recoverOrphanedDataQueueRateLimitJobsPerInterval=1
export mergePrimaryAndSecondaryEnabled=true
export maxNumberSecondsPrimaryRemainsUnhealthy=30
export maxNumberSecondsSecondaryRemainsUnhealthy=10

# peerSetManager
export peerHealthCheckRequestTimeout=2000 # ms
export minimumMemoryAvailable=2000000000 # bytes; 2gb
export maxFileDescriptorsAllocatedPercentage=95
export maxNumberSecondsPrimaryRemainsUnhealthy=5
export maxNumberSecondsSecondaryRemainsUnhealthy=5

# Number of missed blocks after which we would consider a discovery node unhealthy
export discoveryNodeUnhealthyBlockDiff=10

# Maximum number of wallets the /users/batch_clock_status route will accept at one time
export maxBatchClockStatusBatchSize=5

export entityManagerAddress="0x5b9b42d6e4B2e4Bf8d42Eba32D46918e10899B66"
export entityManagerReplicaSetEnabled="true"

# Premium content
export premiumContentEnabled="true"

cd ../audius-libs
npm link

cd ../app
npm link @audius/sdk

# Run register script in background as it waits for the node to be healthy
node scripts/register.js &
