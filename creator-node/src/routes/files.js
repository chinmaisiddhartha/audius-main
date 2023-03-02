const express = require('express')
const Redis = require('ioredis')
const fs = require('fs-extra')
const path = require('path')
const contentDisposition = require('content-disposition')

const { logger: genericLogger } = require('../logging')
const { getRequestRange, formatContentRange } = require('../utils/requestRange')
const {
  fetchFileFromNetworkAndSaveToFS,
  uploadTempDiskStorage,
  EMPTY_FILE_CID
} = require('../fileManager')
const {
  handleResponse,
  sendResponse,
  successResponse,
  errorResponseBadRequest,
  errorResponseServerError,
  errorResponseNotFound,
  errorResponseForbidden,
  errorResponseRangeNotSatisfiable,
  errorResponseUnauthorized,
  handleResponseWithHeartbeat
} = require('../apiHelpers')
const { recoverWallet } = require('../apiSigning')

const models = require('../models')
const config = require('../config.js')
const redisClient = new Redis(config.get('redisPort'), config.get('redisHost'))
const {
  authMiddleware,
  ensurePrimaryMiddleware,
  issueAndWaitForSecondarySyncRequests,
  ensureStorageMiddleware
} = require('../middlewares')
const { getAllRegisteredCNodes } = require('../services/ContentNodeInfoManager')
const {
  timeout,
  computeFilePath,
  computeFilePathInDir,
  computeLegacyFilePath
} = require('../utils')
const DBManager = require('../dbManager')
const DiskManager = require('../diskManager')
const { libs } = require('@audius/sdk')
const { sequelize } = require('../models')
const Utils = libs.Utils

const BATCH_CID_ROUTE_LIMIT = 500
const BATCH_CID_EXISTS_CONCURRENCY_LIMIT = 50
const BATCH_TRACKID_ROUTE_LIMIT = 250_000

const router = express.Router()

/**
 * Helper method to stream file from file system on creator node
 * Serves partial content if specified using range requests
 * By default, checks path for file existence before proceeding
 * If not provided, checks fs stats for path
 */
const streamFromFileSystem = async (
  req,
  res,
  path,
  checkExistence = true,
  fsStats = null
) => {
  try {
    if (checkExistence) {
      // If file cannot be found on disk, throw error
      if (!(await fs.pathExists(path))) {
        throw new Error(`File could not be found on disk, path=${path}`)
      }
    }

    // Stream file from file system
    let fileStream

    const stat = fsStats || (await fs.stat(path))
    // Add 'Accept-Ranges' if streamable
    if (req.params.streamable) {
      res.set('Accept-Ranges', 'bytes')
    }

    // If a range header is present, use that to create the readstream
    // otherwise, stream the whole file.
    const range = getRequestRange(req)

    // TODO - route doesn't support multipart ranges.
    if (stat && range) {
      let { start, end } = range
      if (end >= stat.size) {
        // Set "Requested Range Not Satisfiable" header and exit
        res.status(416)
        return sendResponse(
          req,
          res,
          errorResponseRangeNotSatisfiable('Range not satisfiable')
        )
      }

      // set end in case end is undefined or null
      end = end || stat.size - 1

      fileStream = fs.createReadStream(path, { start, end })

      // Add a content range header to the response
      res.set('Content-Range', formatContentRange(start, end, stat.size))
      res.set('Content-Length', end - start + 1)
      // set 206 "Partial Content" success status response code
      res.status(206)
    } else {
      fileStream = fs.createReadStream(path)
      res.set('Content-Length', stat.size)
    }

    // If client has provided filename, set filename in header to be auto-populated in download prompt.
    if (req.query.filename) {
      res.setHeader(
        'Content-Disposition',
        contentDisposition(req.query.filename)
      )
    }

    // If content is gated, set cache-control to no-cache.
    // Otherwise, set the CID cache-control so that client caches the response for 30 days.
    // The contentAccessMiddleware sets the req.contentAccess object so that we do not
    // have to make another database round trip to get this info.
    if (req.shouldCache) {
      res.setHeader('cache-control', 'public, max-age=2592000, immutable')
    } else {
      res.setHeader('cache-control', 'no-cache')
    }

    await new Promise((resolve, reject) => {
      fileStream
        .on('open', () => fileStream.pipe(res))
        .on('end', () => {
          res.end()
          resolve()
        })
        .on('error', (e) => {
          genericLogger.error(
            'streamFromFileSystem - error trying to stream from disk',
            e
          )
          reject(e)
        })
    })
  } catch (e) {
    // Unset the cache-control header so that a bad response is not cached
    res.removeHeader('cache-control')

    // Unable to stream from file system. Throw a server error message
    throw e
  }
}

const logGetCIDDecisionTree = (decisionTree, req) => {
  try {
    req.logger.debug(`[getCID] Decision Tree: ${JSON.stringify(decisionTree)}`)
  } catch (e) {
    req.logger.error(`[getCID] Decision Tree - Failed to print: ${e.message}`)
  }
}

/**
 * Given a CID, return the appropriate file
 * 1. Check if file exists at expected storage path (current and legacy)
 * 2. If found, stream from FS
 * 3. Else, check if CID exists in DB. If not, return 404 not found error
 * 4. If exists in DB, fetch file from CN network, save to FS, and stream from FS
 * 5. If not avail in CN network, respond with 400 server error
 */
const getCID = async (req, res) => {
  const CID = req.params.CID
  const trackId = parseInt(req.query.trackId)
  const localOnly = req.query.localOnly === 'true'

  const decisionTree = [{ stage: `BEGIN`, time: `${Date.now()}` }]
  const logPrefix = `[getCID] [CID=${CID}]`

  /**
   * Check if CID is servable from BlacklistManager; return error if not
   */
  let startMs = Date.now()
  const BlacklistManager = req.app.get('blacklistManager')
  const isServable = await BlacklistManager.isServable(CID, trackId)
  decisionTree.push({
    stage: `BLACKLIST_MANAGER_CHECK_IS_SERVABLE`,
    time: `${Date.now() - startMs}ms`
  })
  if (!isServable) {
    decisionTree.push({
      stage: `CID_IS_BLACKLISTED`
    })

    logGetCIDDecisionTree(decisionTree, req)
    return sendResponse(
      req,
      res,
      errorResponseForbidden(
        `${logPrefix} CID has been blacklisted by this node`
      )
    )
  }

  // Compute expected storagePath for CID
  let storagePath
  try {
    storagePath = computeFilePath(CID)
    decisionTree.push({
      stage: `COMPUTE_FILE_PATH_COMPLETE`
    })
  } catch (e) {
    decisionTree.push({
      stage: `COMPUTE_FILE_PATH_FAILURE`
    })
    logGetCIDDecisionTree(decisionTree, req)
    return sendResponse(
      req,
      res,
      errorResponseBadRequest(`${logPrefix} Invalid CID`)
    )
  }

  /**
   * Check if file exists on FS at storagePath
   * If found and not of file type, return error
   * If found and file type, continue
   * If not found, continue
   */
  startMs = Date.now()
  let fileFoundOnFS = false
  let fsStats
  let queryResults
  try {
    /**
     * fs.stat returns instance of fs.stats class, used to check if exists, an dir vs file
     * Throws error if nothing found
     * https://nodejs.org/api/fs.html#fspromisesstatpath-options
     */
    fsStats = await fs.stat(storagePath)
    decisionTree.push({
      stage: `FS_STATS`,
      time: `${Date.now() - startMs}ms`
    })

    if (fsStats.isFile()) {
      decisionTree.push({
        stage: `CID_CONFIRMED_FILE`
      })

      if (CID !== EMPTY_FILE_CID && fsStats.size === 0) {
        // Remove file if it is empty and force fetch from CN network
        await fs.unlink(storagePath)
        decisionTree.push({
          stage: `EMPTY_FILE_FOUND_AND_REMOVED_NEW_PATH`
        })
      } else {
        fileFoundOnFS = true
      }
    } else if (fsStats.isDirectory()) {
      decisionTree.push({
        stage: `CID_CONFIRMED_DIRECTORY`
      })
      logGetCIDDecisionTree(decisionTree, req)
      return sendResponse(
        req,
        res,
        errorResponseBadRequest('this dag node is a directory')
      )
    } else {
      decisionTree.push({
        stage: `CID_INVALID_TYPE`
      })
      logGetCIDDecisionTree(decisionTree, req)
      return sendResponse(
        req,
        res,
        errorResponseBadRequest('CID is of invalid file type')
      )
    }
  } catch (e) {
    decisionTree.push({
      stage: `FS_STATS_CID_NOT_FOUND`,
      time: `${Date.now() - startMs}ms`
    })
    // continue
  }

  /**
   * If not found on FS at storagePath, check legacyStoragePath
   */
  if (!fileFoundOnFS) {
    // Compute expected legacyStoragePath for CID
    let legacyStoragePath
    try {
      legacyStoragePath = computeLegacyFilePath(CID)
      decisionTree.push({
        stage: `COMPUTE_LEGACY_FILE_PATH_COMPLETE`
      })
    } catch (e) {
      decisionTree.push({
        stage: `COMPUTE_LEGACY_FILE_PATH_FAILURE`
      })
      logGetCIDDecisionTree(decisionTree, req)
      return sendResponse(
        req,
        res,
        errorResponseBadRequest(`${logPrefix} Invalid CID`)
      )
    }

    /**
     * Check if file exists on FS at legacyStoragePath
     * If found and not of file type, return error
     * If found and of type file, continue with legacyStoragePath
     * If not found, continue
     */
    startMs = Date.now()
    try {
      // Will throw if path does not exist
      // If exists, returns an instance of fs.stats class
      fsStats = await fs.stat(legacyStoragePath)
      decisionTree.push({
        stage: `FS_STATS_LEGACY_STORAGE_PATH`,
        time: `${Date.now() - startMs}ms`
      })

      if (fsStats.isFile()) {
        decisionTree.push({
          stage: `CID_CONFIRMED_FILE_LEGACY_STORAGE_PATH`
        })
        if (CID !== EMPTY_FILE_CID && fsStats.size === 0) {
          // Remove file if it is empty and force fetch from CN network
          await fs.unlink(storagePath)
          decisionTree.push({
            stage: `EMPTY_FILE_FOUND_AND_REMOVED_LEGACY_PATH`
          })
        } else {
          fileFoundOnFS = true
        }
      } else if (fsStats.isDirectory()) {
        decisionTree.push({
          stage: `CID_CONFIRMED_DIRECTORY_LEGACY_STORAGE_PATH`
        })
        logGetCIDDecisionTree(decisionTree, req)
        return sendResponse(
          req,
          res,
          errorResponseBadRequest('this dag node is a directory')
        )
      } else {
        decisionTree.push({
          stage: `CID_INVALID_TYPE_LEGACY_STORAGE_PATH`
        })
        logGetCIDDecisionTree(decisionTree, req)
        return sendResponse(
          req,
          res,
          errorResponseBadRequest('CID is of invalid file type')
        )
      }
    } catch (e) {
      decisionTree.push({
        stage: `FS_STATS_LEGACY_STORAGE_PATH_CID_NOT_FOUND`,
        time: `${Date.now() - startMs}ms`
      })
      // continue
    }

    if (fileFoundOnFS) {
      storagePath = legacyStoragePath
    }
  }

  /**
   * If the file is found on file system, stream from file system
   */
  if (fileFoundOnFS) {
    startMs = Date.now()
    try {
      const fsStream = await streamFromFileSystem(
        req,
        res,
        storagePath,
        false,
        fsStats
      )
      decisionTree.push({
        stage: `STREAM_FROM_FILE_SYSTEM_COMPLETE`,
        time: `${Date.now() - startMs}ms`
      })
      logGetCIDDecisionTree(decisionTree, req)
      return fsStream
    } catch (e) {
      decisionTree.push({
        stage: `STREAM_FROM_FILE_SYSTEM_FAILED`,
        time: `${Date.now() - startMs}ms`
      })
    }
  }

  /**
   * If not found on FS, check if CID record is in DB, error if not found
   */
  startMs = Date.now()
  try {
    queryResults = await models.File.findOne({
      where: {
        multihash: CID
      },
      order: [['clock', 'DESC']]
    })
    decisionTree.push({
      stage: `DB_CID_QUERY`,
      time: `${Date.now() - startMs}ms`
    })

    if (!queryResults) {
      decisionTree.push({
        stage: `DB_CID_QUERY_CID_NOT_FOUND`
      })
      logGetCIDDecisionTree(decisionTree, req)
      return sendResponse(
        req,
        res,
        errorResponseNotFound(
          `${logPrefix} No valid file found for provided CID`
        )
      )
    } else if (queryResults.type === 'dir') {
      decisionTree.push({
        stage: `DB_CID_QUERY_CONFIRMED_DIR`
      })
      logGetCIDDecisionTree(decisionTree, req)
      return sendResponse(
        req,
        res,
        errorResponseBadRequest('this dag node is a directory')
      )
    } else {
      decisionTree.push({
        stage: `DB_CID_QUERY_CID_FOUND`
      })
    }
  } catch (e) {
    decisionTree.push({
      stage: `DB_CID_QUERY_ERROR`,
      time: `${Date.now() - startMs}ms`,
      error: `${e.message}`
    })
    logGetCIDDecisionTree(decisionTree, req)
    return sendResponse(
      req,
      res,
      errorResponseServerError(`${logPrefix} DB query failed`)
    )
  }

  // try to stream file from storagePath location in db
  startMs = Date.now()
  try {
    // optimization to only try to stream from db storagePath if it's different than computed storagePath
    if (storagePath !== queryResults.storagePath) {
      decisionTree.push({
        stage: `STREAM_FROM_STORAGE_PATH_DB_LOCATION_FROM_FILE_SYSTEM`,
        time: `${Date.now() - startMs}ms`,
        data: { storagePath: queryResults.storagePath }
      })
      const fsStream = await streamFromFileSystem(
        req,
        res,
        queryResults.storagePath,
        false
      )
      decisionTree.push({
        stage: `STREAM_FROM_STORAGE_PATH_DB_LOCATION_FROM_FILE_SYSTEM_COMPLETE`,
        time: `${Date.now() - startMs}ms`
      })
      logGetCIDDecisionTree(decisionTree, req)
      return fsStream
    }
  } catch (e) {
    decisionTree.push({
      stage: `STREAM_FROM_STORAGE_PATH_DB_LOCATION_FROM_FILE_SYSTEM_FAILED`,
      time: `${Date.now() - startMs}ms`
    })
  }

  if (localOnly) {
    return sendResponse(
      req,
      res,
      errorResponseNotFound(
        `${logPrefix} No valid file found locally for provided CID`
      )
    )
  }

  /**
   * If found in DB (means not found in FS):
   * 1. Attempt to retrieve file from network and save to file system
   * 2. If retrieved, stream from file system
   * 3. Else, error
   */
  const blockStartMs = Date.now()
  try {
    startMs = Date.now()
    const { error, storagePath: newStoragePath } =
      await fetchFileFromNetworkAndSaveToFS(
        libs,
        req.logger,
        CID,
        null /* dirCID */,
        [] /* targetGateways */ // no replica set so it will scan the whole network
      )
    if (error) {
      throw new Error(`Not found in network: ${error.message}`)
    }

    storagePath = newStoragePath

    decisionTree.push({
      stage: `FIND_CID_IN_NETWORK_COMPLETE`,
      time: `${Date.now() - startMs}ms`
    })

    startMs = Date.now()
    const fsStream = await streamFromFileSystem(req, res, storagePath, false)
    decisionTree.push({
      stage: `STREAM_FROM_FILE_SYSTEM_AFTER_FIND_CID_IN_NETWORK_COMPLETE`,
      time: `${Date.now() - startMs}ms`
    })

    logGetCIDDecisionTree(decisionTree, req)
    return fsStream
  } catch (e) {
    decisionTree.push({
      stage: `FIND_CID_IN_NETWORK_ERROR`,
      time: `${Date.now() - blockStartMs}ms`,
      error: `${e.message}`
    })
    return sendResponse(req, res, errorResponseServerError(e.message))
  }
}

// Gets a CID in a directory, streaming from the filesystem if available
const getDirCID = async (req, res) => {
  if (!(req.params && req.params.dirCID && req.params.filename)) {
    return sendResponse(
      req,
      res,
      errorResponseBadRequest(`Invalid request, no multihash provided`)
    )
  }

  // Do not act as a public gateway. Only serve files that are tracked by this creator node.
  const dirCID = req.params.dirCID
  const filename = req.params.filename
  const localOnly = req.query.localOnly === 'true'
  const logPrefix = `[getDirCID][dirCID: ${dirCID}][fileName: ${filename}]`

  // We need to lookup the CID so we can correlate with the filename (eg original.jpg, 150x150.jpg)
  // Query for the file based on the dirCID and filename
  const queryResults = await models.File.findOne({
    where: {
      dirMultihash: dirCID,
      fileName: filename
    },
    order: [['clock', 'DESC']]
  })
  if (!queryResults) {
    return sendResponse(
      req,
      res,
      errorResponseNotFound(`${logPrefix} No valid file found in DB`)
    )
  }

  // Compute expected storagePath to minimize reliance on DB storagePath (which will eventually be removed)
  const storagePath = computeFilePathInDir(dirCID, queryResults.multihash)

  // Attempt to stream file from computed storagePath
  try {
    req.logger.info(
      `${logPrefix} - Retrieving ${storagePath} directly from filesystem`
    )
    return await streamFromFileSystem(req, res, storagePath)
  } catch (e) {
    req.logger.error(`${logPrefix} - Failed to retrieve ${storagePath} from FS`)
  }

  // If streaming from computed storagePath fails and DB storagePath is different, attempt to stream file from DB storagePath
  if (queryResults.storagePath !== storagePath) {
    try {
      req.logger.info(
        `${logPrefix} - Retrieving ${queryResults.storagePath} directly from filesystem`
      )
      return await streamFromFileSystem(req, res, queryResults.storagePath)
    } catch (e) {
      req.logger.error(
        `${logPrefix} - Failed to retrieve ${queryResults.storagePath} from FS`
      )
    }
  }

  if (localOnly) {
    return sendResponse(
      req,
      res,
      errorResponseNotFound(`${logPrefix} No valid file found locally`)
    )
  }

  // CID is the file CID, parse it from the storagePath
  const CID = storagePath.split('/').slice(-1).join('')

  // Attempt to find and stream CID from other content nodes in the network
  try {
    const { error, storagePath: newStoragePath } =
      await fetchFileFromNetworkAndSaveToFS(
        libs,
        req.logger,
        CID,
        dirCID,
        [] /* targetGateways */, // no replica set so it will scan the whole network
        filename
      )
    if (error) {
      throw new Error(`Not found in network: ${error.message}`)
    }

    return await streamFromFileSystem(req, res, newStoragePath)
  } catch (e) {
    req.logger.error(
      `${logPrefix} - Error fetching and streaming file from network for CID ${CID}`,
      e.message
    )
    return sendResponse(req, res, errorResponseServerError(e.message))
  }
}

/**
 * Verify that content matches its hash using the IPFS deterministic content hashing algorithm.
 * @param {Object} req
 * @param {File[]} resizeResp resizeImage.js response; should be a File[] of resized images
 * @param {string} dirCID the directory CID from `resizeResp`
 */
const _verifyContentMatchesHash = async function (req, resizeResp, dirCID) {
  const logger = genericLogger.child(req.logContext)
  const content = await _generateContentToHash(resizeResp, dirCID)

  // Re-compute dirCID from all image files to ensure it matches dirCID returned above
  const multihashes = await Utils.fileHasher.generateImageCids(
    content,
    genericLogger.child(req.logContext)
  )

  // Ensure actual and expected dirCIDs match
  const computedDirCID = multihashes[multihashes.length - 1].cid.toString()
  if (computedDirCID !== dirCID) {
    const errMsg = `Image file validation failed - dirCIDs do not match for dirCID=${dirCID} computedDirCID=${computedDirCID}.`
    logger.error(errMsg)
    throw new Error(errMsg)
  }
}

/**
 * Helper fn to generate the input for `generateImageCids()`
 * @param {File[]} resizeResp resizeImage.js response; should be a File[] of resized images
 * @param {string} dirCID the directory CID from `resizeResp`
 * @returns {Object[]} follows the structure [{path: <string>, cid: <string>}, ...] with the same number of elements
 * as the size of `resizeResp`
 */
async function _generateContentToHash(resizeResp, dirCID) {
  const contentToHash = []
  try {
    await Promise.all(
      resizeResp.files.map(async function (file) {
        const fileBuffer = await fs.readFile(file.storagePath)
        contentToHash.push({
          path: file.sourceFile,
          content: fileBuffer
        })
      })
    )
  } catch (e) {
    throw new Error(`Failed to build hashing array for dirCID ${dirCID} ${e}`)
  }

  return contentToHash
}

router.get(
  '/async_processing_status',
  handleResponse(async (req, _res) => {
    const AsyncProcessingQueue =
      req.app.get('serviceRegistry').asyncProcessingQueue

    const redisKey = AsyncProcessingQueue.constructAsyncProcessingKey(
      req.query.uuid
    )
    const value = (await redisClient.get(redisKey)) || '{}'

    return successResponse(JSON.parse(value))
  })
)

/**
 * Store image in multiple-resolutions on disk + DB
 */
router.post(
  '/image_upload',
  authMiddleware,
  ensurePrimaryMiddleware,
  ensureStorageMiddleware,
  uploadTempDiskStorage.single('file'),
  handleResponseWithHeartbeat(async (req, _res) => {
    if (
      !req.body.square ||
      !(req.body.square === 'true' || req.body.square === 'false')
    ) {
      return errorResponseBadRequest(
        'Must provide square boolean param in request body'
      )
    }
    if (!req.file) {
      return errorResponseBadRequest('Must provide image file in request body.')
    }
    const imageProcessingQueue =
      req.app.get('serviceRegistry').imageProcessingQueue

    const routestart = Date.now()
    const imageBufferOriginal = req.file.path
    const originalFileName = req.file.originalname
    const cnodeUserUUID = req.session.cnodeUserUUID

    // Resize the images and add them to filestorage
    let resizeResp
    try {
      if (req.body.square === 'true') {
        resizeResp = await imageProcessingQueue.resizeImage({
          file: imageBufferOriginal,
          fileName: originalFileName,
          sizes: {
            '150x150.jpg': 150,
            '480x480.jpg': 480,
            '1000x1000.jpg': 1000
          },
          square: true,
          logContext: req.logContext
        })
      } /** req.body.square == 'false' */ else {
        resizeResp = await imageProcessingQueue.resizeImage({
          file: imageBufferOriginal,
          fileName: originalFileName,
          sizes: {
            '640x.jpg': 640,
            '2000x.jpg': 2000
          },
          square: false,
          logContext: req.logContext
        })
      }

      req.logger.debug('ipfs add resp', resizeResp)
    } catch (e) {
      return errorResponseServerError(e)
    }

    const dirCID = resizeResp.dir.dirCID

    // Ensure image files written to disk match dirCID returned from resizeImage
    await _verifyContentMatchesHash(req, resizeResp, dirCID)

    // Record image file entries in DB
    const transaction = await models.sequelize.transaction()
    try {
      // Record dir file entry in DB
      const createDirFileQueryObj = {
        multihash: dirCID,
        sourceFile: null,
        storagePath: resizeResp.dir.dirDestPath,
        type: 'dir' // TODO - replace with models enum
      }
      await DBManager.createNewDataRecord(
        createDirFileQueryObj,
        cnodeUserUUID,
        models.File,
        transaction
      )

      // Record all image res file entries in DB
      // Must be written sequentially to ensure clock values are correctly incremented and populated
      for (const file of resizeResp.files) {
        const createImageFileQueryObj = {
          multihash: file.multihash,
          sourceFile: file.sourceFile,
          storagePath: file.storagePath,
          type: 'image', // TODO - replace with models enum
          dirMultihash: dirCID,
          fileName: file.sourceFile.split('/').slice(-1)[0]
        }
        await DBManager.createNewDataRecord(
          createImageFileQueryObj,
          cnodeUserUUID,
          models.File,
          transaction
        )
      }

      req.logger.info(`route time = ${Date.now() - routestart}`)
      await transaction.commit()
    } catch (e) {
      await transaction.rollback()
      return errorResponseServerError(e)
    }

    // Discovery only indexes metadata and not files, so we eagerly replicate data but don't await it
    issueAndWaitForSecondarySyncRequests(req, true)

    return successResponse({ dirCID })
  })
)

/**
 * Serve data hosted by creator node and create download route using query string pattern
 * `...?filename=<file_name.mp3>`.
 * IPFS is not used anymore -- this route only exists with this name because the client uses it in prod
 *
 * @param req
 * @param req.query
 * @param {string} req.query.filename filename to set as the content-disposition header
 * @dev This route does not handle responses by design, so we can pipe the response to client.
 * TODO: It seems like handleResponse does work with piped responses, as seen from the track/stream endpoint.
 */
router.get(['/ipfs/:CID', '/content/:CID'], getCID)

/**
 * Serve images hosted by content node.
 * IPFS is not used anymore -- this route only exists with this name because the client uses it in prod
 * @param req
 * @param req.query
 * @param {string} req.query.filename the actual filename to retrieve w/in the IPFS directory (e.g. 480x480.jpg)
 * @dev This route does not handle responses by design, so we can pipe the gateway response.
 * TODO: It seems like handleResponse does work with piped responses, as seen from the track/stream endpoint.
 */
router.get(['/ipfs/:dirCID/:filename', '/content/:dirCID/:filename'], getDirCID)

/**
 * Serves information on existence of given cids
 * @param req
 * @param req.body
 * @param {string[]} req.body.cids the cids to check existence for, these cids can also be directories
 * @dev This route can have a large number of CIDs as input, therefore we use a POST request.
 */
router.post(
  '/batch_cids_exist',
  handleResponse(async (req, _res) => {
    const { cids } = req.body

    if (cids && cids.length > BATCH_CID_ROUTE_LIMIT) {
      return errorResponseBadRequest(
        `Too many CIDs passed in, limit is ${BATCH_CID_ROUTE_LIMIT}`
      )
    }

    const queryResults = await models.File.findAll({
      attributes: ['multihash', 'storagePath'],
      raw: true,
      where: {
        multihash: {
          [models.Sequelize.Op.in]: cids
        }
      }
    })

    const cidExists = {}

    // Check if hash exists in disk in batches (to limit concurrent load)
    for (
      let i = 0;
      i < queryResults.length;
      i += BATCH_CID_EXISTS_CONCURRENCY_LIMIT
    ) {
      const batch = queryResults.slice(
        i,
        i + BATCH_CID_EXISTS_CONCURRENCY_LIMIT
      )
      const exists = await Promise.all(
        batch.map(({ storagePath }) => fs.pathExists(storagePath))
      )
      batch.map(({ multihash }, idx) => {
        cidExists[multihash] = exists[idx]
      })

      await timeout(250)
    }

    const cidExistanceMap = {
      cids: cids.map((cid) => ({ cid, exists: cidExists[cid] || false }))
    }

    return successResponse(cidExistanceMap)
  })
)

router.post(
  '/batch_id_to_cid',
  handleResponse(async (req, _res) => {
    const { trackIds } = req.body
    if (trackIds && trackIds.length > BATCH_TRACKID_ROUTE_LIMIT) {
      return errorResponseBadRequest(
        `Too many track IDs passed in, limit is ${BATCH_TRACKID_ROUTE_LIMIT}`
      )
    }

    const queryResults = await models.File.findAll({
      attributes: ['multihash', 'trackBlockchainId'],
      raw: true,
      where: {
        trackBlockchainId: {
          [models.Sequelize.Op.in]: trackIds
        },
        type: 'copy320'
      }
    })

    const trackIdMapping = Object.fromEntries(
      queryResults.map(({ trackBlockchainId, multihash }) => [
        trackBlockchainId,
        multihash
      ])
    )

    // return results
    return successResponse(trackIdMapping)
  })
)

router.post(
  '/segment_to_cid',
  handleResponse(async (req, _res) => {
    const { cid, wallet } = req.body
    if (!cid || !wallet) {
      return errorResponseBadRequest(`cid or wallet is missing`)
    }

    const uuid = await models.CNodeUser.findOne({
      attributes: ['cnodeUserUUID'],
      raw: true,
      where: {
        walletPublicKey: wallet
      }
    })

    if (!uuid) {
      return errorResponseNotFound(
        `could not find the user uuid with the wallet provided`
      )
    }

    const queryResults = await sequelize.query(
      `
      SELECT multihash, "trackBlockchainId", "sourceFile"
      FROM "Files" 
      WHERE "sourceFile" in (
        SELECT "sourceFile" 
        FROM "Files" 
        WHERE "multihash" = :trackSegmentCid
      )
      AND "type" = 'copy320'
      AND "cnodeUserUUID" = :cnodeUserUUID
    `,
      {
        replacements: {
          trackSegmentCid: cid,
          cnodeUserUUID: uuid
        }
      }
    )

    const copy320Cid = queryResults

    return successResponse(copy320Cid)
  })
)

/**
 * Serves information on existence of given image cids
 * @param req
 * @param req.body
 * @param {string[]} req.body.cids the cids to check existence for, these cids should be directories containing original.jpg
 * @dev This route can have a large number of CIDs as input, therefore we use a POST request.
 */
router.post(
  '/batch_image_cids_exist',
  handleResponse(async (req, _res) => {
    const { cids } = req.body

    if (cids && cids.length > BATCH_CID_ROUTE_LIMIT) {
      return errorResponseBadRequest(
        `Too many CIDs passed in, limit is ${BATCH_CID_ROUTE_LIMIT}`
      )
    }

    const queryResults = await models.File.findAll({
      attributes: ['dirMultihash', 'storagePath'],
      raw: true,
      where: {
        dirMultihash: {
          [models.Sequelize.Op.in]: cids
        },
        fileName: 'original.jpg'
      }
    })

    const cidExists = {}

    // Check if hash exists in disk in batches (to limit concurrent load)
    for (
      let i = 0;
      i < queryResults.length;
      i += BATCH_CID_EXISTS_CONCURRENCY_LIMIT
    ) {
      const batch = queryResults.slice(
        i,
        i + BATCH_CID_EXISTS_CONCURRENCY_LIMIT
      )
      const exists = await Promise.all(
        batch.map(({ storagePath }) => fs.pathExists(storagePath))
      )
      batch.map(({ dirMultihash }, idx) => {
        cidExists[dirMultihash] = exists[idx]
      })

      await timeout(250)
    }

    const cidExistanceMap = {
      cids: cids.map((cid) => ({ cid, exists: cidExists[cid] || false }))
    }

    return successResponse(cidExistanceMap)
  })
)

/**
 * Serve file from FS given a storage path
 * This is a cnode-cnode only route, not to be consumed by clients. It has auth restrictions to only
 * allow calls from cnodes with delegateWallets registered on chain
 * @dev No handleResponse around this route because it doesn't play well with our route handling abstractions,
 * same as the /ipfs route
 * @deprecated - Remove once all nodes stop calling as part of findCIDInNetwork, leaving in for backwards compatibility
 * @param req.query.filePath the fs path for the file. should be full path including leading /file_storage
 * @param req.query.delegateWallet the wallet address that signed this request
 * @param req.query.timestamp the timestamp when the request was made
 * @param req.query.signature the hashed signature of the object {filePath, delegateWallet, timestamp}
 * @param {string?} req.query.trackId the trackId of the requested file lookup
 */
router.get('/file_lookup', async (req, res) => {
  const BlacklistManager = req.app.get('blacklistManager')
  const { filePath, timestamp, signature } = req.query
  let { delegateWallet, trackId } = req.query
  delegateWallet = delegateWallet.toLowerCase()
  trackId = parseInt(trackId)

  // no filePath passed in
  if (!filePath)
    return sendResponse(
      req,
      res,
      errorResponseBadRequest(`Invalid request, no path provided`)
    )

  // check that signature is correct and delegateWallet is registered on chain
  const recoveredWallet = recoverWallet(
    { filePath, delegateWallet, timestamp },
    signature
  ).toLowerCase()
  const contentNodes = await getAllRegisteredCNodes(req.logger)
  const foundDelegateWallet = contentNodes.some(
    (node) => node.delegateOwnerWallet.toLowerCase() === recoveredWallet
  )
  if (recoveredWallet !== delegateWallet || !foundDelegateWallet) {
    return sendResponse(
      req,
      res,
      errorResponseUnauthorized(`Invalid wallet signature`)
    )
  }
  const filePathNormalized = path.normalize(filePath)

  // check that the regex works and verify it's not blacklisted
  const matchObj = DiskManager.extractCIDsFromFSPath(filePathNormalized)
  if (!matchObj)
    return sendResponse(
      req,
      res,
      errorResponseBadRequest(`Invalid filePathNormalized provided`)
    )

  const { outer, inner } = matchObj
  let isServable = await BlacklistManager.isServable(outer, trackId)
  if (!isServable) {
    return sendResponse(
      req,
      res,
      errorResponseForbidden(`CID=${outer} has been blacklisted by this node.`)
    )
  }

  res.setHeader('Content-Disposition', contentDisposition(outer))

  // inner will only be set for image dir CID
  // if there's an inner CID, check if CID is blacklisted and set content disposition header
  if (inner) {
    isServable = await BlacklistManager.isServable(inner, trackId)
    if (!isServable) {
      return sendResponse(
        req,
        res,
        errorResponseForbidden(
          `CID=${inner} has been blacklisted by this node.`
        )
      )
    }
    res.setHeader('Content-Disposition', contentDisposition(inner))
  }

  try {
    return await streamFromFileSystem(req, res, filePathNormalized)
  } catch (e) {
    return sendResponse(
      req,
      res,
      errorResponseNotFound(`File with path not found`)
    )
  }
})

module.exports = router
module.exports.getCID = getCID
module.exports.streamFromFileSystem = streamFromFileSystem
