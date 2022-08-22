import debug from 'debug'
import fs from 'fs'
import util from 'util'
import AWS from 'aws-sdk'
import mime from 'mime-types'

const streamPipeline = util.promisify(require('stream').pipeline)

const log = debug('pins:sendPinsToPickupBucket')

// TODO: Cast id to string
const GET_PINNED_PINS_QUERY = `
  SELECT * FROM pin WHERE status = 'Pinned' AND pickup_url IS NULL LIMIT 50000
`

const s3 = new AWS.S3({})

/**
 * @param {{ env: NodeJS.ProcessEnv, rwPg: Client, roPg: Client, cluster: import('@nftstorage/ipfs-cluster').Cluster }} config
 */
export async function sendPinsToPickupBucket ({ env, roPg, rwPg, cluster }) {
  if (!log.enabled) {
    console.log('ℹ️ Enable logging by setting DEBUG=pins:sendPinsToPickupBucket')
  }

  const { rows } = await roPg.query(GET_PINNED_PINS_QUERY)

  for (const row of rows) {
    // Get the content from IPFS
    const fileStatus = await cluster.status(row.content_cid)

    if (fileStatus !== undefined) {
      const fileUrl = `${cluster.url}/${row.content_cid}`

      // Download the file from IPFS
      const fileData = await fetch(fileUrl)
      const bucketKey = `pins/${row.id}/${row.content_cid}`
      if (!fileData.ok) {
        log('Failed to correctly fetch the file. Skipping.')
        continue
      }

      const fileType = fileData.headers.get('Content-Type')
      const fileName = `./${bucketKey}.${mime.extension(fileType)}`
      await streamPipeline(fileData.body, fs.createWriteStream(fileName))

      const fileContent = fs.readFileSync(fileName)

      // Upload it to S3
      await s3.putObject({
        Bucket: env.s3PickupBucketName,
        Body: fileContent,
        Key: bucketKey
      }).promise()

      await rwPg.query(
        `UPDATE pin SET (pickup_url) VALUES (${`https://${env.s3PickupBucketName}.s3.${env.s3PickupBucketRegion}.amazonaws.com/${bucketKey}`})
      WHERE id = ${row.id} AND content_cid = ${row.content_cid}`)
    }
  }

  log('🎉 Done')
}
