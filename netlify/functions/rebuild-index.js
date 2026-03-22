const {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");

const R2_PUBLIC_URL = "https://pub-42ef583694d949bca7c5c104422f55c7.r2.dev";

function encodeR2Path(key) {
  return key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers };
  }

  // Simple auth: require a secret token to prevent abuse
  const authToken = process.env.REBUILD_SECRET;
  const provided =
    (event.queryStringParameters && event.queryStringParameters.token) ||
    (event.headers && event.headers["x-rebuild-token"]);

  if (authToken && provided !== authToken) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ success: false, error: "Unauthorized" }),
    };
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
    // ─── STEP 1: List all m3u8 files ───
    let m3u8Files = [];
    let continuationToken = undefined;
    let pageCount = 0;

    do {
      const command = new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: "videos/",
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      });

      const response = await s3.send(command);
      pageCount++;

      console.log(
        `Page ${pageCount}: ${response.Contents ? response.Contents.length : 0} objects, IsTruncated: ${response.IsTruncated}`
      );

      if (response.Contents) {
        for (const obj of response.Contents) {
          if (obj.Key.endsWith(".m3u8")) {
            m3u8Files.push(obj.Key);
          }
        }
      }

      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);

    console.log(
      `Listed ${pageCount} pages, found ${m3u8Files.length} m3u8 files`
    );

    // ─── STEP 2: Build video index ───
    const videoMap = {};

    for (const key of m3u8Files) {
      const parts = key.split("/");
      const filename = parts.pop();
      const videoDir = parts.join("/");
      const quality = filename.replace(".m3u8", "");

      if (!videoMap[videoDir]) {
        const pathParts = [...parts];
        pathParts.shift(); // remove "videos"

        const videoFolder = pathParts.pop() || "";
        const videoName = videoFolder
          .replace(/\.mp4_\d+p$/i, "")
          .replace(/_/g, " ")
          .trim();

        videoMap[videoDir] = {
          id: Buffer.from(videoDir).toString("base64url"),
          name: videoName || videoFolder,
          path: videoDir,
          course: (pathParts[0] || "").trim(),
          module: (pathParts[1] || "").trim(),
          category: (pathParts[2] || "").trim(),
          qualities: [],
          urls: {},
        };
      }

      videoMap[videoDir].qualities.push(quality);
      videoMap[videoDir].urls[quality] = `${R2_PUBLIC_URL}/${encodeR2Path(key)}`;
    }

    const qualityOrder = { "720p": 1, "1080p": 2, "2160p": 3 };
    const videos = Object.values(videoMap);
    for (const v of videos) {
      v.qualities.sort(
        (a, b) => (qualityOrder[a] || 99) - (qualityOrder[b] || 99)
      );
    }

    videos.sort((a, b) => {
      return (
        a.course.localeCompare(b.course) ||
        a.module.localeCompare(b.module) ||
        a.category.localeCompare(b.category) ||
        a.name.localeCompare(b.name)
      );
    });

    // ─── STEP 3: Upload videos.json to R2 ───
    const indexData = {
      success: true,
      videos,
      total: videos.length,
      builtAt: new Date().toISOString(),
    };

    const body = JSON.stringify(indexData);

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: "videos.json",
        Body: body,
        ContentType: "application/json",
        CacheControl: "public, max-age=300",
      })
    );

    console.log(
      `Uploaded videos.json with ${videos.length} videos (${body.length} bytes)`
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: `Index rebuilt: ${videos.length} videos`,
        total: videos.length,
        builtAt: indexData.builtAt,
        sizeBytes: body.length,
      }),
    };
  } catch (err) {
    console.error("Rebuild error:", err.message, err.stack);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};
