const express = require('express')
const fs = require('fs-extra')

const config = require('../config')
const models = require('../models')
const { saveFileFromBufferToDisk } = require('../fileManager')
const {
  handleResponse,
  successResponse,
  errorResponseBadRequest,
  errorResponseServerError
} = require('../apiHelpers')
const {
  validateStateForImageDirCIDAndReturnFileUUID,
  validateMetadata
} = require('../utils')
const {
  authMiddleware,
  ensurePrimaryMiddleware,
  ensureStorageMiddleware,
  issueAndWaitForSecondarySyncRequests
} = require('../middlewares')
const DBManager = require('../dbManager')

const router = express.Router()

/**
 * Create AudiusUser from provided metadata, and make metadata available to network
 */
router.post(
  '/audius_users/metadata',
  authMiddleware,
  ensurePrimaryMiddleware,
  ensureStorageMiddleware,
  handleResponse(async (req, _res) => {
    const metadataJSON = req.body.metadata
    const metadataBuffer = Buffer.from(JSON.stringify(metadataJSON))
    const cnodeUserUUID = req.session.cnodeUserUUID
    const isValidMetadata = validateMetadata(req, metadataJSON)
    if (!isValidMetadata) {
      return errorResponseBadRequest('Invalid User Metadata')
    }

    // Save file from buffer to disk
    let multihash, dstPath
    try {
      const resp = await saveFileFromBufferToDisk(req, metadataBuffer)
      multihash = resp.cid
      dstPath = resp.dstPath
    } catch (e) {
      return errorResponseServerError(
        `saveFileFromBufferToDisk op failed: ${e}`
      )
    }

    // Record metadata file entry in DB
    const transaction = await models.sequelize.transaction()
    let fileUUID
    try {
      const createFileQueryObj = {
        multihash,
        sourceFile: req.fileName,
        storagePath: dstPath,
        type: 'metadata' // TODO - replace with models enum
      }
      const file = await DBManager.createNewDataRecord(
        createFileQueryObj,
        cnodeUserUUID,
        models.File,
        transaction
      )
      fileUUID = file.fileUUID
      await transaction.commit()
    } catch (e) {
      await transaction.rollback()
      return errorResponseServerError(`Could not save to db: ${e}`)
    }

    // Await 2/3 write quorum (replicating data to at least 1 secondary)
    await issueAndWaitForSecondarySyncRequests(req)

    return successResponse({
      metadataMultihash: multihash,
      metadataFileUUID: fileUUID
    })
  })
)

/**
 * Given audiusUser blockchainUserId, blockNumber, and metadataFileUUID, creates/updates AudiusUser DB entry
 * and associates image file entries with audiusUser. Ends audiusUser creation/update process.
 */
router.post(
  '/audius_users',
  authMiddleware,
  ensurePrimaryMiddleware,
  ensureStorageMiddleware,
  handleResponse(async (req, _res) => {
    const { blockchainUserId, blockNumber, metadataFileUUID } = req.body

    if (!blockchainUserId || !blockNumber || !metadataFileUUID) {
      return errorResponseBadRequest(
        'Must include blockchainUserId, blockNumber, and metadataFileUUID.'
      )
    }

    const cnodeUser = req.session.cnodeUser
    if (blockNumber < cnodeUser.latestBlockNumber) {
      return errorResponseBadRequest(
        `Invalid blockNumber param ${blockNumber}. Must be greater or equal to previously processed blocknumber ${cnodeUser.latestBlockNumber}.`
      )
    }

    // Verify that wallet of the user on the blockchain for the given ID matches the user attempting to update
    const serviceRegistry = req.app.get('serviceRegistry')
    const { libs } = serviceRegistry
    if (config.get('entityManagerReplicaSetEnabled')) {
      const encodedUserId = libs.Utils.encodeHashId(blockchainUserId)
      const spResponse = await libs.discoveryProvider.getUserReplicaSet({
        encodedUserId,
        blockNumber
      })
      if (
        (spResponse?.wallet ?? '').toLowerCase() !==
        req.session.wallet.toLowerCase()
      ) {
        throw new Error(
          `Owner wallet ${spResponse?.wallet} of blockchainUserId ${blockchainUserId} does not match the wallet of the user attempting to write this data: ${req.session.wallet}`
        )
      }
    } else {
      const userResp = await libs.contracts.UserFactoryClient.getUser(
        blockchainUserId
      )
      if (
        !userResp?.wallet ||
        userResp.wallet.toLowerCase() !== req.session.wallet.toLowerCase()
      ) {
        throw new Error(
          `Owner wallet ${userResp.wallet} of blockchainUserId ${blockchainUserId} does not match the wallet of the user attempting to write this data: ${req.session.wallet}`
        )
      }
    }

    const cnodeUserUUID = req.session.cnodeUserUUID

    // Fetch metadataJSON for metadataFileUUID.
    const file = await models.File.findOne({
      where: { fileUUID: metadataFileUUID, cnodeUserUUID }
    })
    if (!file) {
      return errorResponseBadRequest(
        `No file db record found for provided metadataFileUUID ${metadataFileUUID}.`
      )
    }
    let metadataJSON
    try {
      const fileBuffer = await fs.readFile(file.storagePath)
      metadataJSON = JSON.parse(fileBuffer)
    } catch (e) {
      return errorResponseServerError(
        `No file stored on disk for metadataFileUUID ${metadataFileUUID} at storagePath ${file.storagePath}: ${e}.`
      )
    }

    // Get coverArtFileUUID and profilePicFileUUID for multihashes in metadata object, if present.
    let coverArtFileUUID, profilePicFileUUID
    try {
      ;[coverArtFileUUID, profilePicFileUUID] = await Promise.all([
        validateStateForImageDirCIDAndReturnFileUUID(
          req,
          metadataJSON.cover_photo_sizes
        ),
        validateStateForImageDirCIDAndReturnFileUUID(
          req,
          metadataJSON.profile_picture_sizes
        )
      ])
    } catch (e) {
      return errorResponseBadRequest(e.message)
    }

    // Record AudiusUser entry + update CNodeUser entry in DB
    const transaction = await models.sequelize.transaction()
    try {
      const createAudiusUserQueryObj = {
        metadataFileUUID,
        metadataJSON,
        blockchainId: blockchainUserId,
        coverArtFileUUID,
        profilePicFileUUID
      }
      await DBManager.createNewDataRecord(
        createAudiusUserQueryObj,
        cnodeUserUUID,
        models.AudiusUser,
        transaction
      )

      // Update cnodeUser.latestBlockNumber
      await cnodeUser.update(
        { latestBlockNumber: blockNumber },
        { transaction }
      )

      await transaction.commit()

      // Discovery only indexes metadata and not files, so we eagerly replicate data but don't await it
      issueAndWaitForSecondarySyncRequests(req, true)

      return successResponse()
    } catch (e) {
      await transaction.rollback()
      return errorResponseServerError(e.message)
    }
  })
)

module.exports = router
