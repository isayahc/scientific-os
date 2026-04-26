import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const bucket = process.env.S3_BUCKET ?? "generated-assets";
const endpoint = process.env.S3_ENDPOINT ?? "http://localhost:9000";
const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT ?? endpoint;

const s3Client = new S3Client({
  endpoint,
  forcePathStyle: true,
  region: process.env.S3_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
  },
});

let bucketReady: Promise<void> | null = null;

async function ensureBucket() {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
  }

  await s3Client.send(new PutBucketPolicyCommand({
    Bucket: bucket,
    Policy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: "*",
          Action: ["s3:GetObject"],
          Resource: [`arn:aws:s3:::${bucket}/*`],
        },
      ],
    }),
  }));
}

export async function ensureObjectStorage() {
  if (!bucketReady) {
    bucketReady = ensureBucket();
  }

  return bucketReady;
}

export async function uploadImageObject(args: {
  objectKey: string;
  body: Buffer;
  metadata?: Record<string, string>;
}) {
  await ensureObjectStorage();

  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: args.objectKey,
    Body: args.body,
    ContentType: "image/png",
    Metadata: args.metadata,
  }));

  return {
    bucket,
    objectKey: args.objectKey,
    url: `${publicEndpoint.replace(/\/$/, "")}/${bucket}/${args.objectKey}`,
  };
}
