const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");

// ─── IN-MEMORY CACHE ───
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cachedBody = null;
let cacheTimestamp = 0;

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers };
  }

  // Return in-memory cache if fresh
  const now = Date.now();
  if (cachedBody && now - cacheTimestamp < CACHE_TTL_MS) {
    console.log(
      "Cache hit (age: " + Math.round((now - cacheTimestamp) / 1000) + "s)"
    );
    return { statusCode: 200, headers, body: cachedBody };
  }

  const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
  const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
  const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;
  const BUCKET_NAME = process.env.R2_BUCKET_NAME || "s3-projeto-cirurgiao";

  if (!ACCOUNT_ID || !R2_ACCESS_KEY || !R2_SECRET_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error:
          "Missing R2 credentials. Set CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.",
      }),
    };
  }

  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY,
      secretAccessKey: R2_SECRET_KEY,
    },
  });

  try {
    // Fetch the pre-built videos.json from R2 (single GET — fast)
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: "videos.json",
      })
    );

    const body = await response.Body.transformToString();

    // Update in-memory cache
    cachedBody = body;
    cacheTimestamp = Date.now();

    console.log("Fetched videos.json from R2 (" + body.length + " bytes)");

    return { statusCode: 200, headers, body };
  } catch (err) {
    console.error("Error fetching videos.json:", err.message);

    // If videos.json doesn't exist yet, return helpful error
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          success: false,
          error:
            "Video index not found. Call /api/rebuild-index to build it first.",
        }),
      };
    }

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};
