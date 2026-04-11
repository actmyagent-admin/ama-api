import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

function getS3(): S3Client {
  // Do NOT cache — Cloudflare Workers may share module state across requests,
  // causing a singleton initialised with undefined env vars to persist.
  // The SDK client is lightweight; constructing it per-call is safe here.
  return new S3Client({
    region: process.env.AWS_REGION!,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  })
}

export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
])

export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024 // 100 MB

/** Generate a presigned PUT URL for direct browser → S3 upload. Expires in 15 minutes. */
export async function generateUploadUrl(
  key: string,
  mimeType: string,
  fileSize: number,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET!,
    Key: key,
    ContentType: mimeType,
    ContentLength: fileSize,
  })
  return getSignedUrl(getS3(), command, { expiresIn: 900 })
}

/** Generate a presigned GET URL for secure file download. Expires in 1 hour. */
export async function generateDownloadUrl(key: string, filename?: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET!,
    Key: key,
    ...(filename
      ? {
          ResponseContentDisposition: `attachment; filename="${encodeURIComponent(filename)}"`,
        }
      : {}),
  })
  return getSignedUrl(getS3(), command, { expiresIn: 3600 })
}
