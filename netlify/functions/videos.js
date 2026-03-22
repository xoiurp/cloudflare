const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");

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
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers };
  }

  const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
  const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
  const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;
  const BUCKET_NAME = process.env.R2_BUCKET_NAME || "s3-projeto-cirurgiao";

  console.log("Config:", { ACCOUNT_ID: !!ACCOUNT_ID, R2_ACCESS_KEY: !!R2_ACCESS_KEY, R2_SECRET_KEY: !!R2_SECRET_KEY, BUCKET_NAME });

  if (!ACCOUNT_ID || !R2_ACCESS_KEY || !R2_SECRET_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: "Missing R2 credentials. Set CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.",
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
    let m3u8Files = [];
    let continuationToken = undefined;
    let pageCount = 0;

    do {
      const command = new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        MaxKeys: 20,
        Delimiter: "/",
        ContinuationToken: continuationToken,
      });

      const response = await s3.send(command);
      pageCount++;

      const totalObjects = response.Contents ? response.Contents.length : 0;
      console.log(`Page ${pageCount}: ${totalObjects} objects, IsTruncated: ${response.IsTruncated}`);

      // Log root-level folders and files
      if (response.CommonPrefixes) {
        console.log("Root folders:", response.CommonPrefixes.map(p => p.Prefix));
      }
      if (pageCount === 1 && response.Contents) {
        console.log("Root files:", response.Contents.slice(0, 10).map(o => o.Key));
      }

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

    console.log(`Listed ${pageCount} pages, found ${m3u8Files.length} m3u8 files`);
    if (m3u8Files.length > 0) {
      console.log("Sample m3u8:", m3u8Files.slice(0, 3));
    }

    // Group m3u8 files by video directory
    const videoMap = {};

    for (const key of m3u8Files) {
      const parts = key.split("/");
      const filename = parts.pop(); // e.g. "1080p.m3u8"
      const videoDir = parts.join("/"); // e.g. "videos/Course/Module/Cat/Video.mp4_2160p"
      const quality = filename.replace(".m3u8", ""); // e.g. "1080p"

      if (!videoMap[videoDir]) {
        const pathParts = [...parts];
        pathParts.shift(); // remove "videos"

        const videoFolder = pathParts.pop() || ""; // e.g. "Video.mp4_2160p"
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

    // Sort qualities consistently: 720p, 1080p, 2160p
    const qualityOrder = { "720p": 1, "1080p": 2, "2160p": 3 };
    const videos = Object.values(videoMap);
    for (const v of videos) {
      v.qualities.sort((a, b) => (qualityOrder[a] || 99) - (qualityOrder[b] || 99));
    }

    // Sort videos by course > module > category > name
    videos.sort((a, b) => {
      return (
        a.course.localeCompare(b.course) ||
        a.module.localeCompare(b.module) ||
        a.category.localeCompare(b.category) ||
        a.name.localeCompare(b.name)
      );
    });

    console.log(`Found ${videos.length} videos`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        videos,
        total: videos.length,
      }),
    };
  } catch (err) {
    console.error("Function error:", err.message, err.stack);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};
