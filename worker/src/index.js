const R2_PUBLIC_URL = "https://pub-42ef583694d949bca7c5c104422f55c7.r2.dev";
const PROGRESS_KEY = "_rebuild_progress.json";
const INDEX_KEY = "videos.json";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function encodeR2Path(key) {
  return key.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

// Same grouping logic as the original videos.js
function buildVideosFromKeys(m3u8Files) {
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
        id: btoa(unescape(encodeURIComponent(videoDir)))
          .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
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
    v.qualities.sort((a, b) => (qualityOrder[a] || 99) - (qualityOrder[b] || 99));
  }
  videos.sort((a, b) =>
    a.course.localeCompare(b.course) ||
    a.module.localeCompare(b.module) ||
    a.category.localeCompare(b.category) ||
    a.name.localeCompare(b.name)
  );
  return videos;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ─── GET /videos ───
    if (url.pathname === "/videos" && request.method === "GET") {
      try {
        const obj = await env.VIDEOS_BUCKET.get(INDEX_KEY);
        if (obj) {
          return new Response(await obj.text(), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
              ...CORS_HEADERS,
            },
          });
        }
        return jsonResponse({ success: false, error: "Index not built yet. Use the Rebuild button." }, 404);
      } catch (err) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // ─── POST /rebuild-step ───
    // Each call scans up to 5 pages (5000 objects), saves .m3u8 keys in batch files.
    // Progress file is lightweight (cursor + metadata only).
    if (url.pathname === "/rebuild-step" && request.method === "POST") {
      try {
        let progress = { cursor: null, pagesDone: 0, batchCount: 0, totalKeys: 0, done: false };
        const existing = await env.VIDEOS_BUCKET.get(PROGRESS_KEY);
        if (existing) {
          try { progress = await existing.json(); } catch (e) { /* fresh */ }
        }

        if (progress.done) {
          return jsonResponse({
            success: true, done: true,
            message: "Index already built. POST /rebuild-reset to start over.",
            pagesDone: progress.pagesDone, totalKeys: progress.totalKeys,
          });
        }

        const PAGES_PER_CALL = 5;
        let keysThisBatch = [];
        let finished = false;

        for (let i = 0; i < PAGES_PER_CALL; i++) {
          const listOptions = { prefix: "videos/", limit: 1000 };
          if (progress.cursor) listOptions.cursor = progress.cursor;

          const listed = await env.VIDEOS_BUCKET.list(listOptions);
          progress.pagesDone++;

          for (const obj of listed.objects) {
            if (obj.key.endsWith(".m3u8")) {
              keysThisBatch.push(obj.key);
            }
          }

          if (!listed.truncated) {
            finished = true;
            progress.cursor = null;
            break;
          }
          progress.cursor = listed.cursor;
        }

        // Save batch keys to separate file
        if (keysThisBatch.length > 0) {
          await env.VIDEOS_BUCKET.put(
            `_batch_${progress.batchCount}.json`,
            JSON.stringify(keysThisBatch),
            { httpMetadata: { contentType: "application/json" } }
          );
          progress.totalKeys += keysThisBatch.length;
          progress.batchCount++;
        }

        if (finished) {
          // Collect all batches
          let allKeys = [];
          for (let b = 0; b < progress.batchCount; b++) {
            const batchObj = await env.VIDEOS_BUCKET.get(`_batch_${b}.json`);
            if (batchObj) {
              allKeys = allKeys.concat(await batchObj.json());
            }
          }

          // Build final index
          const videos = buildVideosFromKeys(allKeys);
          const indexData = {
            success: true,
            videos,
            total: videos.length,
            builtAt: new Date().toISOString(),
          };
          await env.VIDEOS_BUCKET.put(INDEX_KEY, JSON.stringify(indexData), {
            httpMetadata: { contentType: "application/json" },
          });

          // Cleanup batch files
          for (let b = 0; b < progress.batchCount; b++) {
            await env.VIDEOS_BUCKET.delete(`_batch_${b}.json`);
          }

          progress.done = true;
          await env.VIDEOS_BUCKET.put(PROGRESS_KEY, JSON.stringify(progress), {
            httpMetadata: { contentType: "application/json" },
          });

          return jsonResponse({
            success: true, done: true,
            pagesDone: progress.pagesDone,
            m3u8Count: allKeys.length,
            totalVideos: videos.length,
            message: `Index complete! ${videos.length} videos indexed.`,
          });
        }

        // Save progress
        await env.VIDEOS_BUCKET.put(PROGRESS_KEY, JSON.stringify(progress), {
          httpMetadata: { contentType: "application/json" },
        });

        return jsonResponse({
          success: true, done: false,
          pagesDone: progress.pagesDone,
          totalKeys: progress.totalKeys,
          keysThisBatch: keysThisBatch.length,
          message: `${progress.pagesDone} pages scanned, ${progress.totalKeys} m3u8 found. Call again.`,
        });
      } catch (err) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // ─── POST /rebuild-reset ───
    if (url.pathname === "/rebuild-reset" && request.method === "POST") {
      try {
        await env.VIDEOS_BUCKET.delete(PROGRESS_KEY);
        for (let b = 0; b < 100; b++) {
          await env.VIDEOS_BUCKET.delete(`_batch_${b}.json`);
        }
        return jsonResponse({ success: true, message: "Progress cleared." });
      } catch (err) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    return jsonResponse({ error: "Not found. Use GET /videos, POST /rebuild-step, POST /rebuild-reset" }, 404);
  },
};
