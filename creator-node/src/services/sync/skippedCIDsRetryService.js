const { Queue, Worker } = require('bullmq')

const models = require('../../models')
const { logger } = require('../../logging')
const utils = require('../../utils')
const { clusterUtilsForWorker } = require('../../utils')
const {
  getAllRegisteredCNodes
} = require('../../services/ContentNodeInfoManager')
const { fetchFileFromNetworkAndSaveToFS } = require('../../fileManager')

const LogPrefix = '[SkippedCIDsRetryQueue]'

const RETRY_QUEUE_HISTORY = 500

/**
 * TODO - consider moving queue/jobs off main process. Will require re-factoring of job processing / dependencies
 */
class SkippedCIDsRetryQueue {
  constructor(nodeConfig, libs) {
    if (!nodeConfig || !libs) {
      throw new Error(`${LogPrefix} Cannot start without nodeConfig, libs`)
    }
    this.nodeConfig = nodeConfig
    this.libs = libs
    const connection = {
      host: nodeConfig.get('redisHost'),
      port: nodeConfig.get('redisPort')
    }
    this.queue = new Queue('skipped-cids-retry-queue', {
      connection,
      defaultJobOptions: {
        // these required since completed/failed jobs data set can grow infinitely until memory exhaustion
        removeOnComplete: RETRY_QUEUE_HISTORY,
        removeOnFail: RETRY_QUEUE_HISTORY
      }
    })
  }

  logDebug(msg) {
    logger.debug(`${LogPrefix} ${msg}`)
  }

  logInfo(msg) {
    logger.info(`${LogPrefix} ${msg}`)
  }

  logError(msg) {
    logger.error(`${LogPrefix} ${msg}`)
  }

  async init() {
    try {
      const connection = {
        host: this.nodeConfig.get('redisHost'),
        port: this.nodeConfig.get('redisPort')
      }

      // Clean up anything that might be still stuck in the queue on restart
      if (clusterUtilsForWorker.isThisWorkerFirst()) {
        await this.queue.drain(true)
      }

      const SkippedCIDsRetryQueueJobIntervalMs = this.nodeConfig.get(
        'skippedCIDsRetryQueueJobIntervalMs'
      )
      const CIDMaxAgeMs =
        this.nodeConfig.get('skippedCIDRetryQueueMaxAgeHr') * 60 * 60 * 1000 // convert from Hr to Ms

      const _worker = new Worker(
        'skipped-cids-retry-queue',
        async (_job) => {
          try {
            await this.process(CIDMaxAgeMs, this.libs)
          } catch (e) {
            this.logError(`Failed to process job || Error: ${e.message}`)
          }

          // Re-enqueue job after some interval
          await utils.timeout(SkippedCIDsRetryQueueJobIntervalMs, false)
          await this.queue.add('skipped-cids-retry', { startTime: Date.now() })
        },
        { connection }
      )

      // Add first job to queue
      await this.queue.add('skipped-cids-retry', { startTime: Date.now() })
      this.logDebug(`Successfully initialized and enqueued initial job.`)
    } catch (e) {
      this.logError(`Failed to start`)
    }
  }

  /**
   * Attempt to re-fetch all previously skipped files
   * Only process files with age <= maxAge
   */
  async process(CIDMaxAgeMs, libs) {
    const startTimestampMs = Date.now()
    const oldestFileCreatedAtDate = new Date(startTimestampMs - CIDMaxAgeMs)

    // Only process files with createdAt >= oldest createdAt
    const skippedFiles = await models.File.findAll({
      where: {
        type: { [models.Sequelize.Op.ne]: 'dir' }, // skip over 'dir' type since there is no content to sync
        skipped: true,
        createdAt: { [models.Sequelize.Op.gte]: oldestFileCreatedAtDate }
      },
      // Order by createdAt desc to make sure old, unavailable files do not repeatedly delay processing
      order: [['createdAt', 'DESC']]
    })

    let registeredGateways = await getAllRegisteredCNodes(logger)
    registeredGateways = registeredGateways.map((nodeInfo) => nodeInfo.endpoint)

    // Intentionally run sequentially to minimize node load
    const savedFileUUIDs = []
    for await (const file of skippedFiles) {
      // Returns boolean success indicator
      const { error } = await fetchFileFromNetworkAndSaveToFS(
        libs,
        logger,
        file.multihash,
        file.dirMultihash,
        registeredGateways,
        file.fileName,
        file.trackBlockchainId
      )
      if (!error) {
        savedFileUUIDs.push(file.fileUUID)
      }
      // Do nothing on failure, since that is the default behavior
    }

    // Update DB entries for all previously-skipped files that were successfully saved to flip `skipped` flag
    if (savedFileUUIDs.length) {
      await models.File.update(
        { skipped: false },
        {
          where: { fileUUID: savedFileUUIDs }
        }
      )
    }

    this.logInfo(
      `Completed run in ${
        Date.now() - startTimestampMs
      }ms. Processing files created >= ${oldestFileCreatedAtDate}. Successfully saved ${
        savedFileUUIDs.length
      } of total ${skippedFiles.length} processed.`
    )
  }
}

module.exports = SkippedCIDsRetryQueue
