import { join, relative, resolve, parse } from 'path'
import { stat } from 'fs/promises'
import { createReadStream } from 'fs'
import zlib from 'zlib'

import * as core from '@actions/core'
import * as glob from '@actions/glob'
import * as github from '@actions/github'

import {
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  S3Client,
} from '@aws-sdk/client-s3'

import type { S3ClientConfig } from '@aws-sdk/client-s3'

/**
 * GZipping certain files that are already compressed will likely not yield further size reductions. Creating large temporary gzip
 * files then will just waste a lot of time before ultimately being discarded (especially for very large files).
 * If any of these types of files are encountered then on-disk gzip creation will be skipped and the original file will be uploaded as-is
 */
const gzipExemptFileExtensions = [
  '.gzip',
  '.zip',
  '.tar.lz',
  '.tar.gz',
  '.tar.bz2',
  '.7z'
]

const multipartThreshold = 6 * 1024 ** 2  // 6MB
const multipartChunksize = 5 * 1024 ** 2 // 5MB


function handleError(error: any): void {
  console.error(error)
  core.setFailed(`Artifact upload failed: ${error}`)
}


const getArtifactStats = async (fileOrDirectory: string) => {
  const inputStats = await stat(fileOrDirectory)

  let stats
  let size
  let count

  if (inputStats.isDirectory()) {
    const globber = await glob.create(join(fileOrDirectory, '**', '*'))
    const files = await globber.glob()
    const allStats = await Promise.all(files.map(async (file) => {
      const stats = await stat(file)

      return {
        filepath: resolve(file),
        isFile: stats.isFile(),
        size: stats.size,
      }
    }))

    stats = allStats.filter((s) => s.isFile)
    size = stats.reduce((i, { size }) => i + size, 0)
    count = stats.length
  } else {
    stats = [{
      filepath: resolve(fileOrDirectory),
      isFile: true,
      size: inputStats.size,
    }]
    size = inputStats.size
    count = 1
  }

  return { stats, size, count }
}


class ProgressLogger {
  fileCount: number
  fileTotal: number
  byteCount: number
  byteTotal: number
  debounce: number
  lastLogCall: number
  pendingLogCall: NodeJS.Timer | null

  constructor(fileTotal: number, totalBytes: number, debounceMs = 10000) {
    this.fileCount = 0
    this.fileTotal = fileTotal
    this.byteCount = 0
    this.byteTotal = totalBytes
    this.debounce = debounceMs
    this.lastLogCall = Number(new Date()) - debounceMs
    this.pendingLogCall = null
  }

  get message() {
    const { fileCount, fileTotal, byteCount, byteTotal } = this
    const percentage = (byteCount / byteTotal).toFixed(1)

    return `Total file count: ${fileTotal}`
      + ' ---- '
      + `Processed file #${fileCount} (${percentage}%)`
  }

  update(bytes: number) {
    this.byteCount += bytes
    this.fileCount++

    const now = Number(new Date())
    const diff = now - this.lastLogCall

    if (diff < this.debounce) {
      if (!this.pendingLogCall) {
        this.pendingLogCall = setTimeout(() => {

          core.info(this.message)

          this.pendingLogCall = null
          this.lastLogCall = Number(new Date())
        }, this.debounce)
      }
    } else {
      core.info(this.message)
      this.lastLogCall = now
    }
  }
}


async function run(): Promise<void> {
  const region = core.getInput('aws_region')
  const accessKeyId = core.getInput('aws_access_key_id')
  const secretAccessKey = core.getInput('aws_secret_access_key')
  const bucket = core.getInput('bucket')
  const scope = core.getInput('scope')
  const name = core.getInput('name')
  const artifactPath = core.getInput('path')

  const { owner, repo } = github.context.repo

  const clientConfig: S3ClientConfig = { region }

  if (accessKeyId && secretAccessKey) {
    clientConfig.credentials = {
      accessKeyId,
      secretAccessKey
    }
    core.debug('Using provided credentials.')
  } else if (accessKeyId === null) {
    core.warning(
      'AWS Access Key ID is required if providing an AWS Secret Access Key. '
      + 'Ignoring provided AWS Secret Access Key.'
    )
  } else if (secretAccessKey === null) {
    core.warning(
      'AWS Secret Access Key is required if providing an AWS Access Key ID. '
      + 'Ignoring provided AWS Access Key ID.'
    )
  }

  const artifactPrefix = scope === 'global'
    ? `${owner}/${repo}/${name}`
    : `${owner}/${repo}/${github.context.runId}/${name}`

  core.debug('Calculating artifact properties.')

  const { stats, size, count } = await getArtifactStats(artifactPath)

  core.info(`With the provided path, there will be ${count} files uploaded`)
  core.info('Starting artifact upload')
  // TODO - Validate artifact name
  core.info('Artifact name is valid!')
  core.info(`Container for artifact "${name}" successfully created. Starting upload of file(s)`)

  const progressLogger = new ProgressLogger(count, size)
  const client = new S3Client(clientConfig)

  for (const entry of stats) {
    const { size, filepath } = entry
    const relativePath = relative(artifactPath, filepath)
    const key = `${artifactPrefix}/${relativePath}`

    const fstream = createReadStream(filepath)
    const stream = gzipExemptFileExtensions.includes(parse(filepath).ext)
      ? fstream
      : fstream.pipe(zlib.createGzip())

    if (size > multipartThreshold) {
      const command = new CreateMultipartUploadCommand({
        ContentEncoding: 'gzip',
        Bucket: bucket,
        Key: key,
      })

      const response = await client.send(command)
      const { UploadId } = response

      const multipartConfig = {
        UploadId,
        Bucket: bucket,
        Key: key,
      }

      stream.pause()

      let chunk
      let chunkNumber = 1
      let byteCount = 0

      try {
        while (null !== (chunk = stream.read(multipartChunksize))) {
          const { length } = chunk

          const command = new UploadPartCommand({
            Body: chunk,
            ContentLength: length,
            PartNumber: chunkNumber++,
            // ChecksumSHA256: ,
            ...multipartConfig,
          })

          await client.send(command)

          byteCount += length
          const percentage = (byteCount / size).toFixed(1)

          core.info(`Uploaded ${filepath} (${percentage}%) bytes ${byteCount}:${size}`)
        }
      } catch (error) {
        // TODO - Ensure correct error handling.
        const abort = new AbortMultipartUploadCommand({
          ...multipartConfig
        })

        await client.send(abort)

        throw error
      } finally {
        stream.close()
      }

      const complete = new CompleteMultipartUploadCommand({
        ...multipartConfig
      })

      await client.send(complete)

    } else {
      const command = new PutObjectCommand({
        ContentEncoding: 'gzip',
        Bucket: bucket,
        Key: key,
        Body: stream,
        // ChecksumSHA256: ,
      })

      // TODO - Add retry handler
      try {
        await client.send(command)
      } catch (error) {
        throw error
      } finally {
        stream.close()
      }
    }

    progressLogger.update(size)
  }

  core.info('File upload process has finished.')
  core.info(`Artifact ${name} has been successfully uploaded!`)
}


process.on('unhandledRejection', handleError)
run().catch((error) => handleError(error))
