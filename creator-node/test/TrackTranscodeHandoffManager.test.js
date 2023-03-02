const assert = require('assert')
const sinon = require('sinon')
const nock = require('nock')

const _ = require('lodash')
const uuid = require('uuid')
const axios = require('axios')
const rewire = require('rewire')

const { getLibsMock } = require('./lib/libsMock')

const { logger: genericLogger } = require('../src/logging')
const Utils = require('../src/utils')
const TrackTranscodeHandoffManager = rewire(
  '../src/components/tracks/TrackTranscodeHandoffManager'
)

describe('test TrackTranscodeHandoffManager', function () {
  let libsMock, reqMock
  beforeEach(async () => {
    libsMock = getLibsMock()
    reqMock = {
      logContext: { env: 'TrackTranscodeHandoffManager test' },
      fileDir: 'testFileDir',
      fileName: 'testFileName.mp3',
      fileNameNoExtension: 'testFileName',
      uuid: uuid.v4(),
      libs: libsMock
    }
  })

  afterEach(async function () {
    sinon.restore()
  })

  // handOff()

  it('If selecting random sps fails, return empty response', async function () {
    const revert = TrackTranscodeHandoffManager.__set__(
      'selectRandomSPs',
      async () => {
        throw new Error('i have failed')
      }
    )

    const resp = await TrackTranscodeHandoffManager.handOff(
      { logContext: reqMock.logContext },
      reqMock
    )

    assert.ok(_.isEqual({}, resp))
    revert()
  })

  it('When polling for transcode, if polling fails, return empty response', async function () {
    const revertSelectRandomSPs = TrackTranscodeHandoffManager.__set__(
      'selectRandomSPs',
      async () => {
        return ['http://cn1.com', 'http://cn2.com', 'http://cn3.com']
      }
    )

    const expectedUuid = uuid.v4()
    const revertSendTrackToSp = TrackTranscodeHandoffManager.__set__(
      'sendTrackToSp',
      async () => {
        return expectedUuid
      }
    )

    const revertPollForTranscode = TrackTranscodeHandoffManager.__set__(
      'pollForTranscode',
      async () => {
        throw new Error('polling failed')
      }
    )

    try {
      const resp = await TrackTranscodeHandoffManager.handOff(
        { logContext: reqMock.logContext },
        reqMock
      )
      assert.ok(_.isEqual({}, resp))
    } catch (e) {
      assert.fail(`If polling failed, handOff should not have thrown`)
    }

    revertSelectRandomSPs()
    revertSendTrackToSp()
    revertPollForTranscode()
  })

  // selectRandomSPs()

  it('When libs call fails to get service provider list, throw error', async function () {
    const libsMock = {
      ethContracts: {
        getServiceProviderList: async () => {
          throw new Error('getServiceProviderList() failed')
        }
      }
    }
    try {
      await TrackTranscodeHandoffManager.selectRandomSPs(libsMock)
      assert.fail(
        'Selecting random SPs should have failed if the libs called failed'
      )
    } catch (e) {
      assert.ok(e.message === 'getServiceProviderList() failed')
    }
  })

  it('If there are equal or more SPs returned from contract call than the default number of sps to select, return the default number of sps to select', async function () {
    const allSPs = libsMock.ethContracts.getServiceProviderList('content-node')
    const allSPsSet = new Set(allSPs.map((sp) => sp.endpoint))

    // Return 3 SPs for libs
    const randomSPs = await TrackTranscodeHandoffManager.selectRandomSPs(
      libsMock
    )
    assert.strictEqual(randomSPs.length, 3)
    randomSPs.forEach((sp) => {
      assert.ok(allSPsSet.has(sp))
    })
    assert.ok(!randomSPs.includes(process.env.creatorNodeEndpoint))
  })

  it('If there are less than the default SPs returned from contract call, return the number of SPs returned from the contract call', async function () {
    const allSPs = libsMock.ethContracts.getServiceProviderList('content-node')
    const allSPsSet = new Set(allSPs.map((sp) => sp.endpoint))

    // Mock libs call to only return 2 sp
    libsMock.ethContracts.getServiceProviderList = () => {
      return allSPs.slice(1, 3)
    }

    const randomSPs = await TrackTranscodeHandoffManager.selectRandomSPs(
      libsMock
    )
    assert.strictEqual(randomSPs.length, 2)
    randomSPs.forEach((sp) => {
      assert.ok(allSPsSet.has(sp))
    })
    assert.ok(!randomSPs.includes(process.env.creatorNodeEndpoint))
  })

  // sendTrackToSp()

  it('When handing off transcode request to an sp, if the health check fails, throw error', async function () {
    const revert = TrackTranscodeHandoffManager.__set__(
      'fetchHealthCheck',
      async () => {
        throw new Error('failed to fetch health check response')
      }
    )

    let resp
    try {
      resp = await TrackTranscodeHandoffManager.sendTrackToSp({
        sp: 'http://some_cn.com',
        req: reqMock
      })
      assert.fail('Should not have passed')
    } catch (e) {
      assert.ok(e.message === 'failed to fetch health check response')
    }

    revert()
  })

  it('When handing off transcode request to an sp, if the health check passes but transcode req does not, throw error', async function () {
    sinon.stub(TrackTranscodeHandoffManager, 'fetchHealthCheck').resolves()
    const revertFetchHealthCheck = TrackTranscodeHandoffManager.__set__(
      'fetchHealthCheck',
      async () => {}
    )

    const revertSendTranscode = TrackTranscodeHandoffManager.__set__(
      'sendTranscodeAndSegmentRequest',
      async () => {
        throw new Error('failed to send transcode and segment request')
      }
    )

    let resp
    try {
      resp = await TrackTranscodeHandoffManager.sendTrackToSp({
        sp: 'http://some_cn.com',
        req: reqMock
      })
      assert.fail('Should not have passed')
    } catch (e) {
      assert.ok(e.message === 'failed to send transcode and segment request')
    }

    revertFetchHealthCheck()
    revertSendTranscode()
  })

  it('When handing off transcode request to an sp, if both the health check and transcode passes, return uuid', async function () {
    const revertFetchHealthCheck = TrackTranscodeHandoffManager.__set__(
      'fetchHealthCheck',
      async () => {}
    )

    const expectedUuid = uuid.v4()
    const revertSendTranscode = TrackTranscodeHandoffManager.__set__(
      'sendTranscodeAndSegmentRequest',
      async () => expectedUuid
    )

    try {
      const actualUuid = await TrackTranscodeHandoffManager.sendTrackToSp({
        sp: 'http://some_cn.com',
        req: reqMock
      })
      assert.strictEqual(actualUuid, expectedUuid)
    } catch (e) {
      assert.fail(
        `Transcode handoff failed and UUID was not returned: ${e.message}`
      )
    }

    revertFetchHealthCheck()
    revertSendTranscode()
  })

  it('When fetching segment and writing to fs, if fetching fails, throw error and no files from this call are written to tmp dir', async function () {
    sinon
      .stub(TrackTranscodeHandoffManager, 'fetchSegment')
      .rejects(new Error('fetching segment failed'))

    const revert = TrackTranscodeHandoffManager.__set__(
      'fetchSegment',
      async () => {
        throw new Error('fetching segment failed')
      }
    )

    try {
      await TrackTranscodeHandoffManager.fetchFilesAndWriteToFs({
        fileNameNoExtension: reqMock.fileNameNoExtension,
        transcodeFilePath: `/test_file_storage/files/tmp_track_artifacts/${reqMock.uuid}/${reqMock.uuid}.mp3`,
        segmentFileNames: ['segment00000.ts'],
        segmentFilePaths: [
          `/test_file_storage/files/tmp_track_artifacts/${reqMock.uuid}/segments/segment00000.ts`
        ],
        m3u8FilePath: `/test_file_storage/files/tmp_track_artifacts/${reqMock.uuid}/${reqMock.uuid}.m3u8`
      })
      assert.fail('if fetching segment fails, should not pass')
      // TODO: assert that the files are removed
    } catch (e) {
      assert.ok(e.message === 'fetching segment failed')
    }

    revert()
  })

  it('When fetching transcode and writing to fs, if fetching fails, throw error and no files from this call are written to tmp dir', async function () {
    sinon.stub(Utils, 'writeStreamToFileSystem').resolves()
    const revertFetchSegment = TrackTranscodeHandoffManager.__set__(
      'fetchSegment',
      async () => {
        return { data: 'some stream' }
      }
    )
    const revertFetchTranscode = TrackTranscodeHandoffManager.__set__(
      'fetchTranscode',
      async () => {
        throw new Error('fetching transcode failed')
      }
    )

    try {
      await TrackTranscodeHandoffManager.fetchFilesAndWriteToFs({
        fileNameNoExtension: reqMock.fileNameNoExtension,
        transcodeFilePath: `/test_file_storage/files/tmp_track_artifacts/${reqMock.uuid}/${reqMock.uuid}.mp3`,
        segmentFileNames: ['segment00000.ts'],
        segmentFilePaths: [
          `/test_file_storage/files/tmp_track_artifacts/${reqMock.uuid}/segments/segment00000.ts`
        ],
        m3u8FilePath: `/test_file_storage/files/tmp_track_artifacts/${reqMock.uuid}/${reqMock.uuid}.m3u8`
      })
      assert.fail('if fetching transcode fails, should not pass')
      // TODO: assert that the files are removed
    } catch (e) {
      assert.ok(e.message === 'fetching transcode failed')
    }

    revertFetchSegment()
    revertFetchTranscode()
  })

  it('When fetching m3u8 and writing to fs, if fetching fails, throw error and no files from this call are written to tmp dir', async function () {
    sinon.stub(Utils, 'writeStreamToFileSystem').resolves()
    const revertFetchSegment = TrackTranscodeHandoffManager.__set__(
      'fetchSegment',
      async () => {
        return { data: 'some stream' }
      }
    )
    const revertFetchTranscode = TrackTranscodeHandoffManager.__set__(
      'fetchTranscode',
      async () => {
        return { data: 'some more stream' }
      }
    )
    const revertFetchM3U8File = TrackTranscodeHandoffManager.__set__(
      'fetchM3U8File',
      async () => {
        throw new Error('fetching m3u8 failed')
      }
    )

    try {
      await TrackTranscodeHandoffManager.fetchFilesAndWriteToFs({
        fileNameNoExtension: reqMock.fileNameNoExtension,
        transcodeFilePath: `/test_file_storage/files/tmp_track_artifacts/${reqMock.uuid}/${reqMock.uuid}.mp3`,
        segmentFileNames: ['segment00000.ts'],
        segmentFilePaths: [
          `/test_file_storage/files/tmp_track_artifacts/${reqMock.uuid}/segments/segment00000.ts`
        ],
        m3u8FilePath: `/test_file_storage/files/tmp_track_artifacts/${reqMock.uuid}/${reqMock.uuid}.m3u8`
      })
      assert.fail('if fetching m3u8 fails, should not pass')
      // TODO: assert that the files are removed
    } catch (e) {
      assert.ok(e.message === 'fetching m3u8 failed')
    }

    revertFetchSegment()
    revertFetchTranscode()
    revertFetchM3U8File()
  })

  it('When fetching files and writing to fs, if fetching succeeds, return the file paths', async function () {
    sinon.stub(Utils, 'writeStreamToFileSystem').resolves()
    const revertFetchSegment = TrackTranscodeHandoffManager.__set__(
      'fetchSegment',
      async () => {
        return { data: 'some stream' }
      }
    )
    const revertFetchTranscode = TrackTranscodeHandoffManager.__set__(
      'fetchTranscode',
      async () => {
        return { data: 'some more stream' }
      }
    )
    const revertFetchM3U8File = TrackTranscodeHandoffManager.__set__(
      'fetchM3U8File',
      async () => {
        return { data: 'some more more stream' }
      }
    )

    try {
      const resp = await TrackTranscodeHandoffManager.fetchFilesAndWriteToFs({
        fileNameNoExtension: reqMock.fileNameNoExtension,
        transcodeFilePath: `/test_file_storage/files/tmp_track_artifacts/${reqMock.uuid}/${reqMock.uuid}.mp3`,
        segmentFileNames: ['segment00000.ts'],
        segmentFilePaths: [
          `/test_file_storage/files/tmp_track_artifacts/${reqMock.uuid}/segments/segment00000.ts`
        ],
        m3u8FilePath: `/test_file_storage/files/tmp_track_artifacts/${reqMock.uuid}/${reqMock.uuid}.m3u8`
      })

      assert.strictEqual(
        resp.transcodeFilePath,
        `/test_file_storage/files/tmp_track_artifacts/${reqMock.uuid}/${reqMock.uuid}.mp3`
      )
      assert.strictEqual(resp.segmentFileNames.length, 1)
      assert.strictEqual(resp.segmentFileNames[0], 'segment00000.ts')
      assert.strictEqual(
        resp.m3u8FilePath,
        `/test_file_storage/files/tmp_track_artifacts/${reqMock.uuid}/${reqMock.uuid}.m3u8`
      )
    } catch (e) {
      assert.fail('if fetching files succeed, should not err')
    }

    revertFetchSegment()
    revertFetchTranscode()
    revertFetchM3U8File()
  })

  it('Do not retry if request responds with 404', async function () {
    nock('https://content_node.com')
      .get('/404')
      .reply(404, { data: 'i dont exist........' })

    let didRetry = false
    try {
      await TrackTranscodeHandoffManager.asyncRetryNotOn404({
        logger: genericLogger,
        asyncFn: async () => {
          return axios({
            url: 'https://content_node.com/404',
            method: 'get'
          })
        },
        options: {
          onRetry: () => {
            didRetry = true
          },
          retries: 1
        }
      })
    } catch (e) {
      assert.strictEqual(didRetry, false)
      assert.strictEqual(e.message, 'Route not supported')
      return
    }

    assert.fail('Observed fn should have failed')
  })
})
