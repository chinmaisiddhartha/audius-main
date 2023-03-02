/**
 * NOTE: we import everything explicitly an re-export it
 * in order to support both commonjs style exports (`module.exports`)
 * and the new module style exports (`export`).
 * In the future, once we get a significant amount of the codebase
 * typed, we'll remove the commonjs export syntax and just use
 * the new way of importing/exporting
 */
import {
  timeout,
  getRandomInt,
  verifySignature,
  stringifyMap,
  isFqdn,
  getCharsInRange,
  getCharsInRanges,
  clearActiveJobs
} from './utils'
import {
  validateMetadata,
  validateAssociatedWallets
} from './validateAudiusUserMetadata'
import { verifyCIDMatchesExpected, EMPTY_FILE_CID } from './cidUtils'
import {
  createDirForFile,
  writeStreamToFileSystem,
  getIfAttemptedStateFix,
  validateStateForImageDirCIDAndReturnFileUUID,
  _streamFileToDiskHelper,
  deleteAttemptedStateFixes,
  ensureDirPathExists,
  computeFilePath,
  computeFilePathInDir,
  computeFilePathAndEnsureItExists,
  computeFilePathInDirAndEnsureItExists,
  computeLegacyFilePath
} from './fsUtils'
import { runShellCommand, execShellCommand } from './runShellCommand'
import { currentNodeShouldHandleTranscode } from './contentNodeUtils'
import {
  isClusterEnabled,
  getNumWorkers,
  getConcurrencyPerWorker
} from './cluster/clusterUtils'
import { clusterUtilsForPrimary } from './cluster/clusterUtilsForPrimary'
import { clusterUtilsForWorker } from './cluster/clusterUtilsForWorker'

export * from './types'
export {
  isFqdn,
  timeout,
  getRandomInt,
  verifySignature,
  currentNodeShouldHandleTranscode,
  validateStateForImageDirCIDAndReturnFileUUID,
  deleteAttemptedStateFixes,
  getIfAttemptedStateFix,
  createDirForFile,
  writeStreamToFileSystem,
  _streamFileToDiskHelper,
  runShellCommand,
  execShellCommand,
  validateAssociatedWallets,
  validateMetadata,
  stringifyMap,
  isClusterEnabled,
  getNumWorkers,
  getConcurrencyPerWorker,
  clusterUtilsForPrimary,
  clusterUtilsForWorker,
  clearActiveJobs,
  verifyCIDMatchesExpected,
  ensureDirPathExists,
  computeFilePath,
  computeFilePathInDir,
  computeFilePathAndEnsureItExists,
  computeFilePathInDirAndEnsureItExists,
  computeLegacyFilePath,
  getCharsInRange,
  getCharsInRanges
}

module.exports = {
  isFqdn,
  timeout,
  getRandomInt,
  verifySignature,
  currentNodeShouldHandleTranscode,
  validateStateForImageDirCIDAndReturnFileUUID,
  deleteAttemptedStateFixes,
  getIfAttemptedStateFix,
  createDirForFile,
  writeStreamToFileSystem,
  _streamFileToDiskHelper,
  runShellCommand,
  execShellCommand,
  validateAssociatedWallets,
  validateMetadata,
  stringifyMap,
  verifyCIDMatchesExpected,
  EMPTY_FILE_CID,
  isClusterEnabled,
  getNumWorkers,
  getConcurrencyPerWorker,
  clusterUtilsForPrimary,
  clusterUtilsForWorker,
  clearActiveJobs,
  ensureDirPathExists,
  computeFilePath,
  computeFilePathInDir,
  computeFilePathAndEnsureItExists,
  computeFilePathInDirAndEnsureItExists,
  computeLegacyFilePath,
  getCharsInRange,
  getCharsInRanges
}
