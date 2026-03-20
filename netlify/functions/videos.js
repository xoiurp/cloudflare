const https = require("https");

function cfRequest(url, token) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error("Invalid JSON from Cloudflare API"));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error("Cloudflare API timeout"));
    });
  });
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
  const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

  if (!ACCOUNT_ID || !API_TOKEN) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: "Missing Cloudflare credentials in environment variables" }),
    };
  }

  const PER_PAGE = 1000;

  try {
    let allVideos = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream?per_page=${PER_PAGE}&page=${page}`;
      const data = await cfRequest(url, API_TOKEN);

      if (!data.success) {
        throw new Error(data.errors?.[0]?.message || "Cloudflare API error");
      }

      const results = data.result || [];
      allVideos = allVideos.concat(results);

      // Determine actual per_page the API used (may be less than requested)
      const actualPerPage = data.result_info?.per_page || results.length;
      const totalCount = data.result_info?.total_count;

      // Stop if: no results returned, or we have all videos based on total_count,
      // or results returned fewer than the actual per_page (last page)
      if (results.length === 0) {
        hasMore = false;
      } else if (totalCount && totalCount > 0 && allVideos.length >= totalCount) {
        hasMore = false;
      } else if (results.length < actualPerPage) {
        hasMore = false;
      } else {
        page++;
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        result: allVideos,
        total: allVideos.length,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};
