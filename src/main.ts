import * as core from '@actions/core'
import * as github from '@actions/github'

import { S3ArtifactClient } from 's3-artifact'


async function run(): Promise<void> {
  const region = core.getInput('aws_region')
  const accessKeyId = core.getInput('aws_access_key_id')
  const secretAccessKey = core.getInput('aws_secret_access_key')
  const bucket = core.getInput('bucket')
  const scope = core.getInput('scope')
  const name = core.getInput('name')
  const path = core.getInput('path')

  const client = new S3ArtifactClient(region, accessKeyId, secretAccessKey)

  const result = await client.upload(
    bucket,
    scope,
    name,
    path,
    github.context
  )

  if (!result) {
    core.setFailed('Failed to upload artifact.')
  } else {
    core.info(`Artifact ${name} with ${result.count} files and total size of ${result.size} bytes was successfully uploaded.`)
  }
}

run()
